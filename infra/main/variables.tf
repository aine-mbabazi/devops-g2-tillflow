variable "service_auth_secret_value" {
  type      = string
  sensitive = true
}

variable "tenant_ids" {
  type        = string
  description = "Comma-separated list of tenant IDs the Commission daily close iterates over"
  default     = ""
}

# G5 destroy/rebuild groundwork. Both default false so an ordinary `terraform
# destroy` still fails loudly on a non-empty bucket/repo rather than silently
# discarding versioned objects or shipped images. Flip only via `-var` for a
# deliberate, one-off teardown — see docs/production-readiness.md#teardown.
variable "bucket_force_destroy" {
  type        = bool
  description = "Allow terraform destroy to delete non-empty S3 buckets. Leave false outside a deliberate teardown."
  default     = false
}

variable "ecr_force_delete" {
  type        = bool
  description = "Allow terraform destroy to delete ECR repositories that still hold images. Leave false outside a deliberate teardown."
  default     = false
}
