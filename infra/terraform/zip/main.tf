terraform {
  required_version = ">= 1.11.0, < 2.0.0"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.7" }
  }
  backend "s3" {
    bucket       = "cloudsync-terraform-123456789012"
    key          = "zip.tfstate"
    region       = "ap-southeast-1"
    use_lockfile = true
  }
}
provider "aws" { region = "ap-southeast-1" }
variable "bucket_name" { type = string }
variable "callback_url" { type = string }
variable "zip_service_secret" {
  type      = string
  sensitive = true
}
data "aws_caller_identity" "current" {}
locals {
  name    = "cloudsync-zip"
  bucket  = "arn:aws:s3:::${var.bucket_name}"
  account = data.aws_caller_identity.current.account_id
}
data "archive_file" "code" {
  type        = "zip"
  source_file = "${path.module}/../../../apps/cloud/dist-lambda/zip.mjs"
  output_path = "${path.module}/.terraform/zip.zip"
}
# Write-only keeps the secret out of state. The version is a hash so a Doppler rotation
# reaches Lambda on the next deploy instead of silently diverging from the Worker's copy.
resource "aws_ssm_parameter" "secret" {
  name             = "/cloudsync/zip-service-secret"
  type             = "SecureString"
  value_wo         = var.zip_service_secret
  value_wo_version = parseint(substr(sha256(var.zip_service_secret), 0, 8), 16)
}
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "function" {
  for_each           = toset(["submit", "build"])
  name               = "${local.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}
resource "aws_cloudwatch_log_group" "function" {
  for_each          = toset(["submit", "build"])
  name              = "/aws/lambda/${local.name}-${each.key}"
  retention_in_days = 14
}
resource "aws_iam_role_policy" "function" {
  for_each = toset(["submit", "build"])
  role     = aws_iam_role.function[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = aws_ssm_parameter.secret.arn },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.function[each.key].arn}:*" }
      ], each.key == "submit" ? [
      { Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = ["arn:aws:lambda:ap-southeast-1:${local.account}:function:${local.name}-build"] }
      ] : [
      { Effect = "Allow", Action = ["s3:GetObject"], Resource = ["${local.bucket}/objects/*", "${local.bucket}/system/zip-requests/*"] },
      { Effect = "Allow", Action = ["s3:PutObject", "s3:AbortMultipartUpload"], Resource = ["${local.bucket}/downloads/*", "${local.bucket}/system/zip-outcomes/*"] },
      { Effect = "Allow", Action = ["sqs:SendMessage"], Resource = [aws_sqs_queue.failures.arn] }
    ])
  })
}
resource "aws_sqs_queue" "failures" {
  name                      = "${local.name}-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}
# No reserved concurrency: this account's limit is 10 and AWS refuses any reservation that
# leaves fewer than 10 unreserved. Leases already make duplicate builders harmless.
resource "aws_lambda_function" "build" {
  function_name    = "${local.name}-build"
  role             = aws_iam_role.function["build"].arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "zip.handler"
  filename         = data.archive_file.code.output_path
  source_code_hash = data.archive_file.code.output_base64sha256
  memory_size      = 2048
  timeout          = 900
  environment {
    variables = { S3_BUCKET = var.bucket_name, ZIP_SECRET_PARAMETER = aws_ssm_parameter.secret.name, CALLBACK_URL = var.callback_url }
  }
  depends_on = [aws_cloudwatch_log_group.function, aws_iam_role_policy.function]
}
resource "aws_lambda_function_event_invoke_config" "build" {
  function_name                = aws_lambda_function.build.function_name
  maximum_event_age_in_seconds = 21600
  maximum_retry_attempts       = 1
  destination_config {
    on_failure { destination = aws_sqs_queue.failures.arn }
  }
}
resource "aws_lambda_function" "submit" {
  function_name    = "${local.name}-submit"
  role             = aws_iam_role.function["submit"].arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "zip.handler"
  filename         = data.archive_file.code.output_path
  source_code_hash = data.archive_file.code.output_base64sha256
  memory_size      = 256
  timeout          = 25
  environment {
    variables = { ZIP_SECRET_PARAMETER = aws_ssm_parameter.secret.name, ZIP_BUILDER_FUNCTION_NAME = aws_lambda_function.build.function_name }
  }
  depends_on = [aws_cloudwatch_log_group.function, aws_iam_role_policy.function]
}
resource "aws_apigatewayv2_api" "zip" {
  name          = local.name
  protocol_type = "HTTP"
}
resource "aws_apigatewayv2_integration" "zip" {
  api_id                 = aws_apigatewayv2_api.zip.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.submit.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 26000
}
resource "aws_apigatewayv2_route" "zip" {
  api_id    = aws_apigatewayv2_api.zip.id
  route_key = "POST /zip/{id}"
  target    = "integrations/${aws_apigatewayv2_integration.zip.id}"
}
resource "aws_apigatewayv2_stage" "zip" {
  api_id      = aws_apigatewayv2_api.zip.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 10
    throttling_rate_limit  = 5
  }
}
resource "aws_lambda_permission" "http" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.submit.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.zip.execution_arn}/*/POST/zip/*"
}
output "zip_service_url" { value = aws_apigatewayv2_stage.zip.invoke_url }
