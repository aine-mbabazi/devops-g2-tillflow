# ADR 0005 — The AWS CodePipeline lane is not built

- **Status:** Accepted — this is a knowingly unmet requirement, not an oversight
- **Date:** 2026-09-21
- **DRI:** @mercykilonzo (CI/CD + golden path)
- **Cross-review:** @aine-mbabazi (Platform + delivery)

## Context

The brief requires **two delivery lanes, one release authority**:

| Lane | Path |
|---|---|
| GitHub Actions | PR checks → `plan` on PR → approved `apply` on `main` via OIDC |
| AWS CodePipeline | GitHub App/CodeConnections → CodeBuild → scan gate → ECR (SHA/digest) → ECS → post-deploy smoke/rollback |

The GitHub Actions lane is complete. **The CodePipeline lane does not exist** —
there is no `aws_codepipeline`, `aws_codebuild` or `aws_codestarconnections_*`
resource anywhere in `infra/`.

This ADR records why it was not built, because an unmet requirement with a
stated reason defends differently from one nobody noticed.

## Decision

Do not build the CodePipeline lane. Ship the GitHub Actions lane as the single
delivery path and document the gap.

## Why

**1. It cannot be fully provisioned by Terraform.**

`aws_codestarconnections_connection` is created in `PENDING` status. Completing
the GitHub handshake requires a human to authorise it in the AWS console; there
is no API for that step, by design. So even a complete Terraform build would
land a pipeline that cannot run until someone clicks through a console — which
is precisely the kind of "console changes earn no evidence credit" state the
brief warns against.

**2. The permissions are not in place, and adding them is not free.**

The apply role is an explicit allow-list. `codepipeline`, `codebuild` and
`codestar-connections` are all absent. Today has shown what adding a service to
that list costs: a PR, a merge, an apply, and — twice — an IAM propagation race
where the role granted itself a permission and used it under two seconds later.
See `docs/scar-log.md`.

**3. The apply pipeline was red when the decision was taken.**

`main` could not apply at all on the final day (an `aws_synthetics_canary` that
is not creatable in this account, see the scar log). Adding a second delivery
lane to a stack that cannot apply would have produced Terraform nobody could
run, on the day it needed to be demonstrated.

**4. What it would have added over the existing lane is mostly duplication.**

The GitHub Actions lane already does the things the brief lists under the
CodePipeline lane's "owner defends" column:

| Required capability | Where it already exists |
|---|---|
| Scan gate | `pr.yml` — secret, dependency and IaC scans, failing on fixable HIGH/CRITICAL |
| SBOM | `release-*.yml` — CycloneDX from the shipped image, by digest |
| ECR by SHA/digest | `release-*.yml` — built and deployed by digest, never by tag |
| Deployment health gate | `release-*.yml` — post-deploy smoke: rollout state, target health, and the running digest matching the built digest |
| Rollback evidence | `release-*.yml` — automatic rollback to the pre-deploy task definition, job still fails |

What is genuinely lost is **lane independence**: a second path that survives
GitHub Actions being unavailable, and the artifact-promotion semantics
CodePipeline gives natively. That is a real loss and is not being argued away.

## Consequences

**Accepted.**

- The brief's two-lane requirement is unmet. If graded literally against that
  table, this scores zero rather than partially.
- There is a single point of failure in delivery: if GitHub Actions is down, or
  the OIDC trust policy breaks (which it has once — see the scar log), there is
  no second path to production.

**Mitigated, partly.**

- Every capability the second lane was meant to prove is exercised in the first
  lane and evidenced in `evidence/reliability-operations/README.md`.
- The release path is reproducible from a clean checkout: images build by
  digest, task definitions are registered by Terraform, and a rollback target
  is captured before every deploy.

**Not mitigated.**

- Lane independence. There is one delivery path, and it is GitHub Actions.

## What building it would take

Recorded so the next person does not have to rediscover it:

1. `codepipeline:*`, `codebuild:*`, `codestar-connections:*` added to the apply
   role, applied, and allowed to propagate.
2. `aws_codestarconnections_connection`, then a **manual console authorisation**
   of the GitHub connection.
3. A CodeBuild project per service with a `buildspec` covering test → build →
   scan → push by digest.
4. `aws_codepipeline` with Source → Build → Scan gate → Deploy (ECS) stages,
   plus a post-deploy smoke action and a rollback path.
5. An S3 artifact bucket for pipeline artifacts, which the existing
   `devops-g2-artifacts` bucket can serve.

Estimated at well over the time available on the final day, with step 2 a hard
blocker on a human being in the console.
