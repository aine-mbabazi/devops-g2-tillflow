# Single-AZ RDS PostgreSQL per ADR 0002: cost trade-off consistent with the
# single-NAT decision. Accepted risk: an AZ outage takes the database down
# until AWS recovers it. Multi-AZ is the G3 upgrade.
resource "random_password" "db" {
  length  = 32
  special = false # the value goes into a postgresql:// URL unescaped
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db-subnets"
  subnet_ids = aws_subnet.private[*].id
  tags       = merge(local.common_tags, { service = "data" })
}

resource "aws_security_group" "rds" {
  name        = "${local.name_prefix}-rds-sg"
  description = "PostgreSQL - accepts connections only from the ECS tasks"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "PostgreSQL from ECS tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  tags = merge(local.common_tags, { service = "data" })
}

resource "aws_db_instance" "main" {
  identifier     = "${local.name_prefix}-db"
  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.t4g.micro"

  allocated_storage     = 20
  storage_type          = "gp3"
  storage_encrypted     = true
  max_allocated_storage = 0 # no autoscaling; demo instance

  db_name  = "tillflow"
  username = "tillflow"
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = false

  backup_retention_period = 7
  backup_window           = "03:00-04:00" # 06:00-07:00 EAT, after the daily close
  maintenance_window      = "sun:04:30-sun:05:30"
  apply_immediately       = true
  skip_final_snapshot     = true

  # The demo tears this down between gates; deleting the instance without a
  # final snapshot keeps `terraform destroy` fast.
  deletion_protection = false

  tags = merge(local.common_tags, { service = "data" })
}

output "rds_endpoint" {
  value = aws_db_instance.main.address
}

output "rds_db_name" {
  value = aws_db_instance.main.db_name
}
