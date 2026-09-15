#!/usr/bin/env bash
# Audits every tagged resource in the region against the capstone naming and
# tagging rules. Exits non-zero on any violation so it can gate a pipeline.
#
#   ./scripts/audit-tags.sh                  # human-readable report
#   ./scripts/audit-tags.sh > evidence/platform-delivery/tag-audit.txt
set -euo pipefail

REGION="${AWS_REGION:-us-east-2}"
PREFIX="${NAME_PREFIX:-devops-g2}"
REQUIRED_KEYS=(group owner environment service managed-by capstone)

for binary in aws jq; do
  command -v "$binary" >/dev/null || { echo "error: $binary is required" >&2; exit 2; }
done

# get-resources only returns resources carrying at least one tag, so a wholly
# untagged resource is invisible here. Cross-check against `terraform state
# list` when a resource you expect is absent from the report.
resources="$(aws resourcegroupstaggingapi get-resources \
  --region "$REGION" \
  --tag-filters "Key=capstone,Values=tillflow" \
  --output json)"

total="$(jq -r '.ResourceTagMappingList | length' <<<"$resources")"
if [[ "$total" -eq 0 ]]; then
  echo "error: no resources tagged capstone=tillflow in $REGION — nothing to audit" >&2
  exit 2
fi

echo "Tag and naming audit — region $REGION, prefix $PREFIX"
echo "Resources audited: $total"
echo

violations=0

while IFS=$'\t' read -r arn missing; do
  echo "MISSING TAGS  $arn"
  echo "              missing: $missing"
  violations=$((violations + 1))
done < <(jq -r --argjson required "$(printf '%s\n' "${REQUIRED_KEYS[@]}" | jq -R . | jq -s .)" '
  .ResourceTagMappingList[]
  | . as $resource
  | ($required - [.Tags[].Key]) as $missing
  | select($missing | length > 0)
  | [$resource.ResourceARN, ($missing | join(", "))]
  | @tsv
' <<<"$resources")

while IFS=$'\t' read -r arn value; do
  echo "BAD TAG VALUE $arn"
  echo "              $value"
  violations=$((violations + 1))
done < <(jq -r '
  .ResourceTagMappingList[]
  | . as $resource
  | (.Tags | map({(.Key): .Value}) | add) as $tags
  | [ (if ($tags["managed-by"] // "terraform") != "terraform"
        then "managed-by is \($tags["managed-by"]), expected terraform" else empty end),
      (if ($tags["capstone"] // "tillflow") != "tillflow"
        then "capstone is \($tags["capstone"]), expected tillflow" else empty end) ] as $bad
  | select($bad | length > 0)
  | [$resource.ResourceARN, ($bad | join("; "))]
  | @tsv
' <<<"$resources")

while IFS= read -r arn; do
  echo "BAD NAME      $arn"
  echo "              does not contain the required prefix \"$PREFIX\""
  violations=$((violations + 1))
done < <(jq -r --arg prefix "$PREFIX" '
  .ResourceTagMappingList[].ResourceARN
  | select(contains($prefix) | not)
' <<<"$resources")

echo
if [[ "$violations" -eq 0 ]]; then
  echo "PASS — $total resources, no naming or tagging violations"
  exit 0
fi

echo "FAIL — $violations violation(s) across $total resources"
exit 1
