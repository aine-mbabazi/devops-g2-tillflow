terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    # Packages the Slack notifier and the synthetic probe from source in this
    # repo, so the deployed code is whatever is on the branch rather than a zip
    # someone uploaded by hand.
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

# default_tags is the safety net: a new taggable resource carries the required
# tags even if whoever adds it forgets to merge local.common_tags.
provider "aws" {
  region = "us-east-2"

  default_tags {
    tags = local.common_tags
  }
}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name_prefix = "devops-g2"
  account_id  = data.aws_caller_identity.current.account_id
  azs         = slice(data.aws_availability_zones.available.names, 0, 2)
  common_tags = {
    group       = "g2"
    owner       = "aine-mbabazi"
    environment = "prod"
    managed-by  = "terraform"
    capstone    = "tillflow"
  }
}
