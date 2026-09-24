locals {
  asset_prefix = "assets"
}

data "aws_s3_bucket" "media" {
  bucket = var.media_bucket_name
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = data.aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_cors_configuration" "media" {
  count  = length(var.upload_cors_allowed_origins) > 0 ? 1 : 0
  bucket = data.aws_s3_bucket.media.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["PUT"]
    allowed_origins = tolist(var.upload_cors_allowed_origins)
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

resource "aws_iam_role" "image_optimizer" {
  name = "${var.name}-image-optimizer"
  tags = var.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "image_optimizer" {
  name = "${var.name}-image-optimizer"
  role = aws_iam_role.image_optimizer.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = data.aws_s3_bucket.media.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${data.aws_s3_bucket.media.arn}/${local.asset_prefix}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${data.aws_s3_bucket.media.arn}/${local.asset_prefix}/*/*/*/*/*"
      },
    ]
  })
}

resource "aws_iam_policy" "media_uploader" {
  name        = "${var.name}-media-uploader"
  description = "Scoped S3 access for the application identity that uploads and deletes media."
  tags        = var.tags

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = data.aws_s3_bucket.media.arn
        Condition = {
          StringLike = { "s3:prefix" = "${local.asset_prefix}/*" }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"]
        Resource = "${data.aws_s3_bucket.media.arn}/${local.asset_prefix}/*"
      },
    ]
  })
}

data "archive_file" "image_optimizer" {
  type        = "zip"
  source_dir  = "${path.module}/lambda"
  output_path = "${path.module}/.terraform/image-optimizer.zip"
  excludes    = ["index.test.mjs", "package.json", "package-lock.json"]
}

resource "aws_lambda_function" "image_optimizer" {
  function_name    = "${var.name}-image-optimizer"
  role             = aws_iam_role.image_optimizer.arn
  filename         = data.archive_file.image_optimizer.output_path
  source_code_hash = data.archive_file.image_optimizer.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs26.x"
  architectures    = ["arm64"]
  memory_size      = 2048
  timeout          = 15
  tags             = var.tags

  environment {
    variables = {
      ALLOWED_WIDTHS = join(",", sort(tolist(var.allowed_widths)))
      ASSET_PREFIX   = local.asset_prefix
      MEDIA_BUCKET   = data.aws_s3_bucket.media.bucket
    }
  }

  lifecycle {
    precondition {
      condition     = fileexists("${path.module}/lambda/node_modules/sharp/package.json") && fileexists("${path.module}/lambda/node_modules/@aws-sdk/client-s3/package.json") && fileexists("${path.module}/lambda/node_modules/@img/sharp-linux-arm64/lib/sharp-linux-arm64-0.35.4.node") && fileexists("${path.module}/lambda/node_modules/@img/sharp-libvips-linux-arm64/lib/libvips-cpp.so.8.18.6")
      error_message = "Build Lambda dependencies for Linux ARM64 with glibc before Terraform so the deployment ZIP contains Sharp, libvips, and the AWS SDK."
    }
  }
}

resource "aws_lambda_function_url" "image_optimizer" {
  function_name      = aws_lambda_function.image_optimizer.function_name
  authorization_type = "AWS_IAM"
  invoke_mode        = "RESPONSE_STREAM"
}

resource "aws_cloudfront_origin_access_control" "media" {
  name                              = "${var.name}-s3"
  description                       = "CloudFront access to ${data.aws_s3_bucket.media.bucket}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_access_control" "image_optimizer" {
  name                              = "${var.name}-optimizer"
  description                       = "CloudFront access to the image optimizer Function URL"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_cache_policy" "assets" {
  name        = "${var.name}-assets"
  comment     = "Immutable asset paths; query strings are ignored."
  default_ttl = 3153600
  max_ttl     = 3153600
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
  }
}

resource "aws_cloudfront_distribution" "media" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.name} media CDN"
  price_class     = "PriceClass_All"
  tags            = var.tags

  origin {
    domain_name              = data.aws_s3_bucket.media.bucket_regional_domain_name
    origin_id                = "media-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.media.id
  }

  origin {
    domain_name              = trimsuffix(trimprefix(aws_lambda_function_url.image_optimizer.function_url, "https://"), "/")
    origin_id                = "image-optimizer"
    origin_access_control_id = aws_cloudfront_origin_access_control.image_optimizer.id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  origin_group {
    origin_id = "image-derivatives"
    failover_criteria { status_codes = [403] }
    member { origin_id = "media-s3" }
    member { origin_id = "image-optimizer" }
  }

  default_cache_behavior {
    target_origin_id       = "media-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = aws_cloudfront_cache_policy.assets.id
    compress               = true
  }

  ordered_cache_behavior {
    path_pattern           = "/assets/*"
    target_origin_id       = "image-derivatives"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = aws_cloudfront_cache_policy.assets.id
    compress               = true
  }

  dynamic "custom_error_response" {
    # An S3 403 triggers origin-group failover to Lambda.
    for_each = [400, 404, 500, 502, 503, 504]
    content {
      error_code            = custom_error_response.value
      error_caching_min_ttl = 86400
    }
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

resource "aws_lambda_permission" "image_optimizer_url" {
  statement_id           = "AllowCloudFrontInvokeUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.image_optimizer.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.media.arn
  function_url_auth_type = "AWS_IAM"
}

resource "aws_lambda_permission" "image_optimizer_invoke" {
  statement_id  = "AllowCloudFrontInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.image_optimizer.function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.media.arn
}

resource "aws_s3_bucket_policy" "media" {
  bucket = data.aws_s3_bucket.media.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontObjectRead"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${data.aws_s3_bucket.media.arn}/${local.asset_prefix}/*"
        Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.media.arn } }
      }
    ]
  })
}
