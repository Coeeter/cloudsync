# Existing private storage and file delivery for one environment. These resources predate
# Terraform and are adopted with import blocks in the environment root; the configuration mirrors
# live settings so adoption plans show no changes. Object contents are never managed here.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "environment" {
  type = string
}

variable "bucket_name" {
  type = string
}

variable "file_hostname" {
  type = string
}

variable "cors_origins" {
  type = list(string)
}

variable "certificate_arn" {
  description = "Shared us-east-1 certificate for the file hostnames (owned by the shared root)."
  type        = string
}

variable "response_headers_policy_id" {
  description = "Shared immutable-private headers policy (owned by the shared root)."
  type        = string
}

variable "public_key_pem" {
  description = "Live CloudFront signing public key (nonsecret); the private key stays in Doppler/SSM."
  type        = string
}

variable "public_key_name" {
  type = string
}

variable "public_key_comment" {
  type    = string
  default = null
}

variable "key_group_name" {
  type = string
}

variable "download_response_code" {
  description = "Live viewer-response function source, captured before adoption."
  type        = string
}

variable "bucket_policy_json" {
  description = "Live bucket policy, captured before adoption."
  type        = string
}

variable "origin_access_control" {
  description = "Live OAC name and description, captured before adoption."
  type = object({
    name        = string
    description = string
  })
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

resource "aws_s3_bucket" "content" {
  bucket        = var.bucket_name
  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "content" {
  bucket = aws_s3_bucket.content.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "content" {
  bucket = aws_s3_bucket.content.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    blocked_encryption_types = ["SSE-C"]
  }
}

resource "aws_s3_bucket_ownership_controls" "content" {
  bucket = aws_s3_bucket.content.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "content" {
  bucket                  = aws_s3_bucket.content.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_cors_configuration" "content" {
  bucket = aws_s3_bucket.content.id
  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD", "PUT"]
    allowed_origins = var.cors_origins
    expose_headers  = ["ETag", "x-amz-checksum-sha256"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "content" {
  bucket                                 = aws_s3_bucket.content.id
  transition_default_minimum_object_size = "all_storage_classes_128K"

  rule {
    id     = "cloudsync-retention"
    status = "Enabled"
    filter {
      prefix = ""
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
    expiration {
      expired_object_delete_marker = true
    }
  }
}

resource "aws_s3_bucket_policy" "content" {
  bucket = aws_s3_bucket.content.id
  policy = var.bucket_policy_json
}

resource "aws_cloudfront_origin_access_control" "content" {
  name                              = var.origin_access_control.name
  description                       = var.origin_access_control.description
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_public_key" "signing" {
  name        = var.public_key_name
  comment     = var.public_key_comment
  encoded_key = var.public_key_pem
}

resource "aws_cloudfront_key_group" "signing" {
  name  = var.key_group_name
  items = [aws_cloudfront_public_key.signing.id]
}

resource "aws_cloudfront_function" "download_response" {
  name    = "cloudsync-download-response-${var.environment}"
  runtime = "cloudfront-js-2.0"
  comment = "Per-request attachment metadata for signed CloudFront downloads"
  code    = var.download_response_code
  publish = true
}

resource "aws_cloudfront_distribution" "files" {
  enabled          = true
  comment          = "CloudSync ${var.environment} private files"
  aliases          = [var.file_hostname]
  price_class      = "PriceClass_200"
  http_version     = "http2and3"
  is_ipv6_enabled  = true
  retain_on_delete = false
  wait_for_deployment = false

  origin {
    origin_id                = "cloudsync-s3-${var.environment}"
    domain_name              = aws_s3_bucket.content.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.content.id
    connection_attempts      = 3
    connection_timeout       = 10
  }

  default_cache_behavior {
    target_origin_id           = "cloudsync-s3-${var.environment}"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = var.response_headers_policy_id
    trusted_key_groups         = [aws_cloudfront_key_group.signing.id]

    function_association {
      event_type   = "viewer-response"
      function_arn = aws_cloudfront_function.download_response.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  lifecycle {
    prevent_destroy = true
  }
}

output "bucket_name" {
  value = aws_s3_bucket.content.bucket
}

output "bucket_arn" {
  value = aws_s3_bucket.content.arn
}

output "distribution_arn" {
  value = aws_cloudfront_distribution.files.arn
}

output "file_url" {
  value = "https://${var.file_hostname}"
}

output "public_key_id" {
  value = aws_cloudfront_public_key.signing.id
}
