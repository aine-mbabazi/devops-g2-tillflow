terraform {
  backend "s3" {
    bucket         = "devops-g2-tillflow-tfstate-240462142849"
    key            = "tillflow/network-ecs/terraform.tfstate"
    region         = "us-east-2"
    dynamodb_table = "devops-g2-tflock"
    encrypt        = true
    kms_key_id     = "alias/devops-g2-s3-key"
    profile        = "assignment3"
  }
}
