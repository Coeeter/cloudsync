# One-time owner setup with admin credentials. CI cannot create its own trust or state bucket.
# State stays local (gitignored); every resource here can be re-imported if it is lost.
terraform {
  required_version = ">= 1.11.0, < 2.0.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}
provider "aws" { region = "ap-southeast-1" }
data "aws_caller_identity" "current" {}
locals {
  account = data.aws_caller_identity.current.account_id
  region  = "ap-southeast-1"
  zip     = "cloudsync-zip"
}
resource "aws_s3_bucket" "state" {
  bucket = "cloudsync-terraform-${local.account}"
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}
resource "aws_iam_role" "deploy" {
  name = "cloudsync-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:Coeeter/cloudsync:ref:refs/heads/main"
        }
      }
    }]
  })
}
resource "aws_iam_role_policy" "deploy" {
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.state.arn },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.state.arn}/*" },
      { Effect = "Allow", Action = ["lambda:*"], Resource = "arn:aws:lambda:${local.region}:${local.account}:function:${local.zip}-*" },
      {
        Effect = "Allow"
        Action = [
          "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:TagRole", "iam:UntagRole", "iam:UpdateRole",
          "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy",
          "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:PassRole",
        ]
        Resource = "arn:aws:iam::${local.account}:role/${local.zip}-*"
      },
      {
        Effect   = "Allow"
        Action   = ["apigateway:*"]
        Resource = ["arn:aws:apigateway:${local.region}::/apis", "arn:aws:apigateway:${local.region}::/apis/*", "arn:aws:apigateway:${local.region}::/tags/*"]
      },
      { Effect = "Allow", Action = ["logs:DescribeLogGroups"], Resource = "*" },
      { Effect = "Allow", Action = ["logs:*"], Resource = "arn:aws:logs:${local.region}:${local.account}:log-group:/aws/lambda/${local.zip}-*" },
      { Effect = "Allow", Action = ["sqs:*"], Resource = "arn:aws:sqs:${local.region}:${local.account}:${local.zip}-*" },
      { Effect = "Allow", Action = ["ssm:DescribeParameters"], Resource = "*" },
      { Effect = "Allow", Action = ["ssm:*"], Resource = "arn:aws:ssm:${local.region}:${local.account}:parameter/cloudsync/*" },
    ]
  })
}
output "deploy_role_arn" { value = aws_iam_role.deploy.arn }
