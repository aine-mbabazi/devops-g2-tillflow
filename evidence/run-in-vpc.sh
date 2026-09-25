#!/usr/bin/env bash
# Runs a one-off command inside the VPC as an ECS Fargate task, reusing an
# EXISTING task definition's IAM role, subnets and security groups — no new
# IAM surface, no new network path. Used where an evidence script needs to
# reach something private-subnet-only (RDS, a PITR restore instance) that a
# laptop or CI runner cannot reach directly.
#
# Required env:
#   CLUSTER            ECS cluster name (e.g. devops-g2)
#   TASK_DEFINITION    family or family:revision to run (e.g. devops-g2-payments)
#   CONTAINER_NAME     container within that task definition to override (e.g. payments)
#   SUBNETS            comma-separated private subnet IDs
#   SECURITY_GROUPS    comma-separated security group IDs
# Optional env:
#   AWS_REGION         default us-east-2
#   ENV_OVERRIDES      JSON array of {"name":...,"value":...} to overlay on the
#                       container (e.g. a restore instance's DATABASE_URL)
#
# Usage:
#   CLUSTER=devops-g2 TASK_DEFINITION=devops-g2-payments CONTAINER_NAME=payments \
#   SUBNETS=subnet-aaa,subnet-bbb SECURITY_GROUPS=sg-ccc \
#   ENV_OVERRIDES='[{"name":"RESTORE_DATABASE_URL","value":"postgresql://..."}]' \
#   evidence/run-in-vpc.sh -- node evidence/reliability-operations/verify-restore.mjs
set -euo pipefail

REGION="${AWS_REGION:-us-east-2}"
: "${CLUSTER:?CLUSTER is required}"
: "${TASK_DEFINITION:?TASK_DEFINITION is required}"
: "${CONTAINER_NAME:?CONTAINER_NAME is required}"
: "${SUBNETS:?SUBNETS is required (comma-separated)}"
: "${SECURITY_GROUPS:?SECURITY_GROUPS is required (comma-separated)}"

if [ "${1:-}" != "--" ]; then
  echo "usage: run-in-vpc.sh -- <command> [args...]" >&2
  exit 1
fi
shift

# Built with `jq --args`, not `printf ... | jq -R .`: the latter is
# line-oriented and would shred any single argument that itself contains a
# newline (e.g. an inline script passed as one `node -e <script>` argument)
# into multiple array elements instead of keeping it as one.
COMMAND_JSON="$(jq -n --args '$ARGS.positional' -- "$@")"
ENV_JSON="${ENV_OVERRIDES:-[]}"
SUBNETS_JSON="$(printf '%s' "$SUBNETS" | jq -R 'split(",")')"
SGS_JSON="$(printf '%s' "$SECURITY_GROUPS" | jq -R 'split(",")')"

CONTAINER_OVERRIDE="$(jq -nc \
  --arg name "$CONTAINER_NAME" --argjson command "$COMMAND_JSON" --argjson env "$ENV_JSON" \
  '{name: $name, command: $command, environment: $env}')"
NETWORK_CONFIG="$(jq -nc \
  --argjson subnets "$SUBNETS_JSON" --argjson sgs "$SGS_JSON" \
  '{awsvpcConfiguration: {subnets: $subnets, securityGroups: $sgs, assignPublicIp: "DISABLED"}}')"

echo "Starting one-off task from $TASK_DEFINITION in $CLUSTER..." >&2
TASK_ARN="$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEFINITION" \
  --launch-type FARGATE \
  --network-configuration "$NETWORK_CONFIG" \
  --overrides "$(jq -nc --argjson c "$CONTAINER_OVERRIDE" '{containerOverrides: [$c]}')" \
  --region "$REGION" \
  --query 'tasks[0].taskArn' --output text)"

if [ -z "$TASK_ARN" ] || [ "$TASK_ARN" = "None" ]; then
  echo "::error::run-task did not return a task ARN" >&2
  exit 1
fi

echo "Task: $TASK_ARN — waiting for it to stop..." >&2
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION"

EXIT_CODE="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION" \
  --query "tasks[0].containers[?name=='$CONTAINER_NAME'].exitCode | [0]" --output text)"

TASK_ID="${TASK_ARN##*/}"
LOG_GROUP="$(aws ecs describe-task-definition --task-definition "$TASK_DEFINITION" --region "$REGION" \
  --query "taskDefinition.containerDefinitions[?name=='$CONTAINER_NAME'].logConfiguration.options.\"awslogs-group\" | [0]" --output text)"
LOG_STREAM_PREFIX="$(aws ecs describe-task-definition --task-definition "$TASK_DEFINITION" --region "$REGION" \
  --query "taskDefinition.containerDefinitions[?name=='$CONTAINER_NAME'].logConfiguration.options.\"awslogs-stream-prefix\" | [0]" --output text)"
LOG_STREAM="${LOG_STREAM_PREFIX}/${CONTAINER_NAME}/${TASK_ID}"

echo "--- logs ($LOG_GROUP/$LOG_STREAM) ---" >&2
aws logs get-log-events \
  --log-group-name "$LOG_GROUP" \
  --log-stream-name "$LOG_STREAM" \
  --region "$REGION" \
  --query 'events[].message' --output text || true

echo "exitCode=$EXIT_CODE" >&2
[ "$EXIT_CODE" = "0" ]
