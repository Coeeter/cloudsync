terraform {
  required_version = ">= 1.10.0, < 2.0.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
  backend "s3" {}
}
provider "aws" { region = "ap-southeast-1" }
variable "environment" { type = string }
variable "bucket_name" { type = string }
variable "cloudfront_distribution_id" { type = string }
variable "callback_url" { type = string }
variable "artifact_bucket" { type = string }
variable "artifact_key" { type = string }
variable "artifact_sha256" { type = string }
variable "secret_parameter" { type = string }
data "aws_s3_bucket" "content" { bucket = var.bucket_name }
data "aws_cloudfront_distribution" "files" { id = var.cloudfront_distribution_id }
data "aws_caller_identity" "current" {}
locals { name = "cloudsync-${var.environment}-zip" }
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
      { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = "arn:aws:ssm:ap-southeast-1:${data.aws_caller_identity.current.account_id}:parameter${var.secret_parameter}" },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.function[each.key].arn}:*" }
      ], [for statement in [
        { Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = ["arn:aws:lambda:ap-southeast-1:${data.aws_caller_identity.current.account_id}:function:${local.name}-build"] }
        ] : statement if each.key == "submit"], [for statement in [
        { Effect = "Allow", Action = ["s3:GetObject"], Resource = ["${data.aws_s3_bucket.content.arn}/objects/*", "${data.aws_s3_bucket.content.arn}/system/zip-requests/*"] },
        { Effect = "Allow", Action = ["s3:PutObject", "s3:AbortMultipartUpload"], Resource = ["${data.aws_s3_bucket.content.arn}/downloads/*", "${data.aws_s3_bucket.content.arn}/system/zip-outcomes/*"] },
        { Effect = "Allow", Action = ["sqs:SendMessage"], Resource = [aws_sqs_queue.failures.arn] }
    ] : statement if each.key == "build"])
  })
}
resource "aws_sqs_queue" "failures" {
  name                      = "${local.name}-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}
resource "aws_lambda_function" "build" {
  function_name                  = "${local.name}-build"
  role                           = aws_iam_role.function["build"].arn
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  handler                        = "zip.handler"
  s3_bucket                      = var.artifact_bucket
  s3_key                         = var.artifact_key
  source_code_hash               = var.artifact_sha256
  memory_size                    = 2048
  timeout                        = 900
  reserved_concurrent_executions = 1
  publish                        = true
  environment {
    variables = { S3_BUCKET = var.bucket_name, ZIP_SECRET_PARAMETER = var.secret_parameter, CALLBACK_URL = var.callback_url }
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
  s3_bucket        = var.artifact_bucket
  s3_key           = var.artifact_key
  source_code_hash = var.artifact_sha256
  memory_size      = 256
  timeout          = 25
  publish          = true
  environment {
    variables = { ZIP_SECRET_PARAMETER = var.secret_parameter, ZIP_BUILDER_FUNCTION_NAME = aws_lambda_function.build.function_name }
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
output "existing_files_url" { value = data.aws_cloudfront_distribution.files.domain_name }
