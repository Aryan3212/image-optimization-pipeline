output "s3_media_bucket_name" {
  value = data.aws_s3_bucket.media.bucket
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.media.domain_name
}

output "distribution_id" {
  value = aws_cloudfront_distribution.media.id
}

output "media_uploader_policy_arn" {
  value       = aws_iam_policy.media_uploader.arn
  description = "Attach this policy to the application identity that issues direct uploads and cleans up assets."
}
