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
