# Image Optimization Pipeline for AWS

This Terraform module puts CloudFront and an image-resizing Lambda in front of an existing private S3 bucket. It also creates an IAM policy for the application that signs upload URLs. Terraform manages the bucket policy, so applying this module replaces any existing bucket-policy statements.

This is an independent project, not affiliated with or endorsed by Amazon Web Services (AWS). Its design can be adapted to another cloud, but this implementation requires AWS services and would need its Terraform resources and Lambda/S3 integration replaced.

You need Terraform, Node.js, npm, an existing private S3 bucket, and AWS credentials that can manage the resources in this project. Configure an S3-backed Terraform state backend for shared deployments; otherwise Terraform uses local state. Terraform does not build the Lambda dependencies: it packages the existing `lambda/node_modules` and checks for Linux ARM64 Sharp and libvips.

From the repository root, run the following. Edit `terraform.tfvars` with your bucket name and AWS Region before planning, and review the plan before applying it.

```sh
cd lambda
npm ci
npm test
npm ci --os=linux --cpu=arm64 --libc=glibc --include=optional
cd ..
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan
terraform apply
```

The second install replaces `node_modules`. On macOS, run the tests before it; the Linux ARM64 Sharp binary cannot load on macOS. Attach the `media_uploader_policy_arn` output to the application identity that signs uploads. Browser uploads can list several allowed origins, such as both an apex domain and its `www` subdomain; they share one bucket CORS configuration.

This pipeline uses these paths (with `480` as an example configured width):

- Original: `/assets/asset-id/v1/0/source/photo.jpg`
- Same-size WebP: `/assets/asset-id/v1/0/webp/photo.jpg.webp`
- Resized WebP: `/assets/asset-id/v1/480/webp/photo.jpg.webp`
- Resized original format: `/assets/asset-id/v1/480/source/photo.jpg`

The application must generate matching keys and URLs; another application can choose a different layout if it updates the Lambda and CDN paths together. A stable asset ID with a new content version gives replacements new URLs, so old cached images need no invalidation. Only `/assets/*` can reach Lambda after an S3 miss.

To add a format, update the accepted source extensions and output formats in `lambda/index.mjs`, make sure Sharp can produce it with the right content type, and update the application's URL generation and Lambda tests.

CloudFront caches eligible 400, 404, and 5xx responses for 24 hours. S3's 403 remains the signal to try Lambda. To investigate failures, configure CloudFront access-log delivery and grant the Lambda role CloudWatch log-writing permissions outside this project. Fix the underlying problem manually and invalidate each affected CloudFront URL manually; otherwise viewers may keep seeing the cached error until it expires. This project does not provision logging.

## Areas to improve

- **AVIF:** The optimizer currently produces WebP, not AVIF. Research AVIF conversion and benchmark Sharp against alternatives; AVIF conversion has been slow in our experiments.
- **Packaging:** Sharp needs native binaries built for the Lambda runtime and CPU architecture. The current deployment uses Linux ARM64; investigate a simpler way to build and publish for ARM64 and x86-64.
- **Missing assets:** On a cache miss under `/assets/*`, CloudFront checks S3 before invoking Lambda. Requests for nonexistent originals can therefore make both origin requests. Investigate how to reject invalid or permanently missing paths earlier.
- **Caching after failover:** In [this AWS re:Post report](https://www.repost.aws/questions/QUnkYNoOJ3QhaFkoKeQJ6blg/cloudfront-origin-group-successful-200-from-secondary-origin-lambda-function-url-after-404-failover-is-not-cached-at-the-edge), a generated image is served by Lambda on the first request, fetched from S3 on the second, and cached on the third. The link documents my own experiments and most of the evidence points to a CloudFront bug but you never know.
- **Redirect instead of streaming:** Investigate returning a 302 after storing a derivative and switching the Lambda Function URL to buffered responses. The redirect needs a distinct target so the requested URL does not redirect to itself; measure the extra request and CloudFront cache behavior.
- **Duplicate conversion locks:** Investigate a DynamoDB conditional-write lease keyed by derivative path so concurrent misses do not process the same image repeatedly. Include lease expiry and recovery, and compare lock overhead with the duplicate work it avoids.

Cost context as of September 2026: Vercel's [Hobby fair-use guideline](https://vercel.com/docs/limits/fair-use-guidelines) lists up to 5,000 image transformations per month. [AWS Lambda's free tier](https://aws.amazon.com/lambda/pricing/) includes 400,000 GB-seconds per month. At this module's 2 GB memory setting, that is about 80,000 conversions if each invocation averages 2.5 seconds and the account has no other Lambda usage. This is a compute-only estimate, not a guaranteed no-cost image allowance; S3 requests and storage, CloudFront usage beyond its free limits, and different conversion times can change the bill.
