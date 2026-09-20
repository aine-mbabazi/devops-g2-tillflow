// Cache-aside layer for the read-heavy path.
//
// The k6 baseline showed the read:write ratio the product actually has — an
// attendant's screen re-reads till configuration far more often than a sale is
// recorded. GET /tenants/:id/config is therefore the one query worth caching:
// read constantly, written only when an owner reconfigures their till, and
// small enough that a whole tenant's config fits comfortably in one key.
//
// Nothing about money is cached. Sale and payment state is read from Postgres
// every time, deliberately — a stale payment status is a double-charge waiting
// to happen, and the read volume there does not justify the risk anyway.

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name_prefix}-cache-subnets"
  subnet_ids = aws_subnet.private[*].id
  tags       = merge(local.common_tags, { service = "data" })
}

resource "aws_security_group" "cache" {
  name        = "${local.name_prefix}-cache-sg"
  description = "Valkey - accepts connections only from the ECS tasks"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Valkey from ECS tasks"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  # No egress rules. A cache node has no reason to originate a connection, and
  # the default deny is the point.

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-cache-sg", service = "data" })
}

# Valkey rather than Redis OSS: same protocol and client libraries, no licence
# question, and materially cheaper per node on ElastiCache. The application
# talks RESP either way, so this is reversible.
resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${local.name_prefix}-cache"
  description          = "TillFlow cache-aside for tenant configuration"

  engine         = "valkey"
  engine_version = "7.2"
  node_type      = "cache.t4g.micro"
  port           = 6379

  # Single node, consistent with the single-AZ RDS trade in ADR 0002. A cache
  # is the one component where this costs least: losing it costs latency, not
  # data, and the application is written to keep serving without it.
  num_cache_clusters         = 1
  automatic_failover_enabled = false
  multi_az_enabled           = false

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.cache.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  # No auth token. Access is already constrained to the ECS tasks' security
  # group inside private subnets, and an auth token would need to live in
  # Secrets Manager and be rotated for a cache holding no secret data. TLS is
  # on regardless, so the traffic is not readable on the wire.

  # An LRU policy, not noeviction: when the cache fills, dropping the
  # least-recently-used key is correct behaviour for a cache-aside layer. With
  # noeviction, writes start failing instead — turning a full cache into an
  # application error.
  parameter_group_name = aws_elasticache_parameter_group.main.name

  maintenance_window       = "sun:05:30-sun:06:30"
  snapshot_retention_limit = 0 # nothing here is worth restoring; it is a cache

  tags = merge(local.common_tags, { service = "data" })
}

resource "aws_elasticache_parameter_group" "main" {
  name   = "${local.name_prefix}-cache-params"
  family = "valkey7"

  parameter {
    name  = "maxmemory-policy"
    value = "allkeys-lru"
  }

  tags = merge(local.common_tags, { service = "data" })
}

# ---------------------------------------------------------------------------
# Alarms — a cache failure must degrade visibly, not silently
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "cache_evictions" {
  alarm_name          = "${local.name_prefix}-cache-evicting"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 100
  period              = 300
  statistic           = "Sum"
  namespace           = "AWS/ElastiCache"
  metric_name         = "Evictions"
  treat_missing_data  = "notBreaching"

  dimensions = { CacheClusterId = "${local.name_prefix}-cache-001" }

  alarm_description = jsonencode({
    service      = "data"
    owner        = "@aine-mbabazi"
    symptom      = "The cache is evicting keys — it no longer holds the working set."
    impact       = "No user-visible failure. Tenant config reads are falling through to RDS, so POS latency will drift toward its 400 ms SLO."
    unit         = "evictions / 5 min"
    panel        = ""
    runbook      = "#cache-degraded"
    first_action = "Check the hit rate before resizing. A low hit rate with high evictions means the TTL is too long for the node size, not that the node is too small."
  })

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = merge(local.common_tags, { service = "data" })
}

output "cache_endpoint" {
  description = "Valkey primary endpoint. TLS is required — clients must connect with rediss://"
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
}
