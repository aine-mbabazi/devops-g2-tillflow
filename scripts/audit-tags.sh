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

# Deliberately no --tag-filters. Filtering on capstone=tillflow would have made
# three of the checks below unfireable: a resource missing that tag, or holding
# a wrong value for it, never enters the result set, so neither the missing-key
# check, the bad-value check, nor the name check could ever see the resources
# most likely to be wrong.
#
# Scope is decided after the fetch instead, by name prefix OR by our identifying
# tags, so a resource that is ours by name but mis-tagged still gets audited,
# and so does one that is ours by tag but misnamed.
#
# Still invisible either way: a resource with no tags at all and no prefix in
# its ARN. get-resources only returns tagged resources, so cross-check against
# `terraform state list` if something you expect is absent from the report.
pages=()
token=""
while :; do
  if [[ -n "$token" ]]; then
    page="$(aws resourcegroupstaggingapi get-resources --region "$REGION" --pagination-token "$token" --output json)"
  else
    page="$(aws resourcegroupstaggingapi get-resources --region "$REGION" --output json)"
  fi
  pages+=("$page")
  # A page caps at 100 resources; without following the token the audit would
  # silently pass by only ever looking at the first hundred.
  token="$(jq -r '.PaginationToken // ""' <<<"$page")"
  [[ -z "$token" ]] && break
done

resources="$(printf '%s\n' "${pages[@]}" | jq -s --arg prefix "$PREFIX" '
  {ResourceTagMappingList: (
    map(.ResourceTagMappingList) | add
    | map(select(
        (.ResourceARN | contains($prefix))
        or ((.Tags // []) | any(.Key == "capstone" and .Value == "tillflow"))
        or ((.Tags // []) | any(.Key == "group" and .Value == "g2"))
      ))
  )}')"

total="$(jq -r '.ResourceTagMappingList | length' <<<"$resources")"
if [[ "$total" -eq 0 ]]; then
  echo "error: no resources matching \"$PREFIX\" or our tags in $REGION — nothing to audit" >&2
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
