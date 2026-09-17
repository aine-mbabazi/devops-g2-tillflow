variable "service_auth_secret_value" {
  type      = string
  sensitive = true
}

variable "tenant_ids" {
  type        = string
  description = "Comma-separated list of tenant IDs the Commission daily close iterates over"
  default     = ""
}
