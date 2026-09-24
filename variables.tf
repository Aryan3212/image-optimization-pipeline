variable "aws_region" {
  description = "AWS region that contains the existing media bucket."
  type        = string
}

variable "media_bucket_name" {
  description = "Name of the existing private S3 bucket that stores media."
  type        = string
}

variable "name" {
  description = "Short identifier used to name CloudFront, Lambda, and IAM resources."
  type        = string
  default     = "image-cdn"
}

variable "allowed_widths" {
  description = "Positive widths accepted in direct derivative paths; width 0 is reserved for source and same-size format conversions."
  type        = set(number)
  default     = [480, 768, 1280, 1920]

  validation {
    condition     = alltrue([for value in var.allowed_widths : value > 0])
    error_message = "Image widths must be positive."
  }
}

variable "upload_cors_allowed_origins" {
  description = "Browser origins allowed to PUT direct uploads. Leave empty to leave the bucket CORS configuration untouched."
  type        = set(string)
  default     = []
}

variable "tags" {
  description = "Tags applied to taggable resources."
  type        = map(string)
  default     = {}
}
