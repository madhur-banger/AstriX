# TLS & Certificate Management

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Infra](./00-master-infra-architecture.md).

Every other file in this module can talk about a resource existing (a subnet, a security group, a role) as a fairly binary fact. TLS certificates are different: a certificate is a *claim* — "the holder of this private key is authorized to speak for this domain name" — and the entire value of HTTPS rests on who is willing to vouch for that claim and how hard it is to forge. A browser trusts a certificate not because the bytes look official, but because some certificate authority (CA) it already trusts signed it, and that CA in turn only signed it after some form of proof that the requester actually controls the domain. Pull any of the load-bearing pieces out of that chain — the CA isn't one browsers trust, or nobody actually checked domain ownership, or the private key backing the cert has leaked — and the padlock icon becomes a lie users have been trained to trust anyway. That's why this file, more than most in the module, treats "how did this certificate come to exist and who signed it" as the central question, not a footnote.

AstriX's own answer turns out to be more interesting, and more unusual, than "call `aws_acm_certificate` and let AWS handle DNS validation." Reading `infra/modules/acm/main.tf` closely reveals a hybrid: a real, working certificate generated *and signed by nobody but AstriX itself* as the default path, with a fully standard, DNS-validated ACM certificate available as an opt-in graduation path once a real domain exists. Understanding exactly which of those two things is happening at any given moment — and what a browser experiences differently in each — is the whole point of this chapter.

---

## 1. The Landscape

Stripped of any particular cloud or tool, the problem is: an HTTPS server needs an X.509 certificate binding its private key to a domain name, signed by something a client's TLS stack is willing to trust, and that certificate needs to stay valid (not expired, not revoked) for as long as the server is running. Four real, distinct approaches dominate how teams actually solve this today.

**(a) Manually purchasing a certificate from a commercial CA.** For most of the web's history, this was the only option: buy a certificate from DigiCert, Sectigo (formerly Comodo), GlobalSign, or a similar commercial CA, prove domain ownership (an email challenge, a DNS TXT record, or an HTTP file upload, depending on validation tier — Domain Validated, Organization Validated, or Extended Validated), download the issued `.crt`/`.key` files, and manually install them on the web server or load balancer. Renewal is just as manual — typically annual or biennial, initiated by a human remembering to do it before the old certificate's expiry date.

```
# the old-school manual flow, illustrative — not AstriX code
openssl req -new -newkey rsa:2048 -nodes -keyout server.key -out server.csr
# submit server.csr to DigiCert/Sectigo, complete domain validation,
# receive server.crt, manually upload both files to the load balancer/server
```

**Tradeoffs:** real, human-vetted trust (EV certificates in particular used to carry visible browser UI — the green company-name bar — though most browsers have since removed that visual distinction), and a paid relationship with a CA that some compliance frameworks or enterprise procurement processes still expect. The operational risk is severe and well-documented across the industry: a forgotten renewal is a guaranteed outage, because an expired certificate fails TLS handshakes outright rather than degrading gracefully, and "the cert expired over the weekend and nobody caught it" is one of the most common self-inflicted incident classes in web operations. Manual key handling also means the private key exists on someone's laptop or in an email attachment at least once, which is its own exposure surface.

**(b) AWS Certificate Manager (ACM) with DNS validation.** AWS's managed answer: request a certificate for a domain, ACM gives back a DNS CNAME record to publish (proving you control the zone), and once that record is visible ACM issues the certificate and — critically — auto-renews it for as long as the validation record stays in place, with zero human involvement. It integrates natively with ALB, CloudFront, and API Gateway as a certificate *reference* (an ARN), never as raw key material a human ever downloads or touches.

**Tradeoffs:** free, fully automated renewal, and the private key never leaves AWS's infrastructure at all — there is no `.pem` file to protect because none is ever generated outside ACM. The cost is platform lock-in: an ACM certificate can only be attached to AWS-native services (ALB, CloudFront, API Gateway, and a handful of others) — you cannot export the private key to install on a self-managed Nginx box or a non-AWS load balancer. It also requires either a Route 53-hosted zone (for fully automated validation) or a one-time manual DNS record if the zone lives elsewhere.

**(c) Let's Encrypt via `cert-manager` (the Kubernetes-ecosystem standard).** In non-AWS-native, multi-cloud, or Kubernetes-based setups, the dominant pattern today is Let's Encrypt — a free, nonprofit CA — automated through the ACME (Automated Certificate Management Environment) protocol, almost always driven by `cert-manager`, the Kubernetes controller that watches `Certificate` custom resources and handles the whole issue/renew/rotate lifecycle by creating short-lived Kubernetes `Secret` objects that ingress controllers mount directly.

```yaml
# illustrative cert-manager Certificate resource — not AstriX code, AstriX runs no Kubernetes
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: api-tls
spec:
  secretName: api-tls-secret
  dnsNames:
    - api.example.com
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
```

**Tradeoffs:** free and cloud-agnostic — the same pattern works on any Kubernetes cluster regardless of which cloud (or bare metal) it runs on, which is exactly why it's become the ecosystem default rather than each cloud's own proprietary certificate manager. Let's Encrypt certificates are also deliberately short-lived (90 days) to force automation rather than tolerate manual renewal, which is a real design philosophy worth internalizing on its own: short validity periods make "someone will remember to renew this" structurally impossible, so the tooling has to be automated from day one. The cost is operational surface — you're now running and trusting a controller (`cert-manager`) with cluster-wide permission to mint certificates, and ACME's domain-validation challenges (HTTP-01 or DNS-01) need a reachable endpoint or DNS API access configured correctly, which is one more moving part versus AWS handling it end-to-end inside its own network. AstriX runs no Kubernetes anywhere in its stack (see file 06's landscape survey for that decision), so this pattern is named here for completeness and industry context, not because AstriX uses any part of it.

**(d) Self-signed certificates.** No CA at all — the entity generates its own key pair and signs its own certificate, vouching for itself. Every browser and TLS client ships with a hardcoded trust store of CAs it accepts; a self-signed certificate isn't in that list (it can't be — there's no way to be, short of a browser vendor adding your specific certificate by name), so every TLS handshake against a self-signed cert produces a trust-chain validation failure, which browsers surface as the familiar "Your connection is not private" / "NET::ERR_CERT_AUTHORITY_INVALID" interstitial. The connection is still *encrypted* — nothing can passively eavesdrop on the traffic — but the identity claim ("this server really is who it says it is") is unverified by any third party the client already trusts.

```
# the whole trust model of a self-signed cert, illustrative
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes
# nobody but the generator vouches this cert belongs to the claimed domain
```

**Tradeoffs:** zero cost, zero external dependency, works entirely offline — genuinely the right (and only sane) choice for local development (`localhost` TLS testing) or truly internal, already-authenticated service-to-service traffic where both ends can be configured to explicitly pin/trust the specific certificate out of band. As a public-facing production pattern it is normally a last resort: every real visitor either sees a scary warning and has to manually override it (training exactly the wrong instinct — more on this in §6) or the client has to be pre-configured to trust that one specific certificate, which doesn't scale past a small, controlled fleet. This option deserves extra care here specifically because AstriX's actual implementation, examined next, overlaps with it more than a passing description would suggest — it is not a purely academic entry in this list for this codebase.

---

## 2. AstriX's Choice

Reading `infra/modules/acm/main.tf` resource by resource (not the module's own header comment, which claims a cleaner story than the code delivers — see §5) shows AstriX runs a genuine hybrid, gated by which optional variables are set, not by environment name: **the default, no-configuration path generates a real self-signed certificate locally via the Terraform `tls` provider and imports it directly into AWS Certificate Manager**, so the ALB's HTTPS listener consumes a real ACM certificate ARN — it just happens to be an ARN backed by a certificate nobody but AstriX itself signed. This is what runs today, because `enable_alb_custom_domain` defaults to `false` and no real domain has been registered for the ALB yet. Sitting alongside that default path, and available purely by flipping variables, is a fully standard, DNS-validated `aws_acm_certificate` for a real custom domain — the same pattern described in landscape option (b) — plus a third fallback that skips certificate creation entirely if a pre-existing certificate ARN is supplied directly. All three paths funnel into one output (`certificate_arn`) that the ALB's HTTPS listener consumes without needing to know which of the three produced it.

---

## 3. AstriX Implementation

### 3.1 Locals — the three-way branch

Everything downstream is driven by two boolean locals computed from three input variables:

```hcl
# infra/modules/acm/main.tf:31-39
locals {
  use_custom_domain = var.enable_custom_domain && var.custom_domain_name != null
  use_self_signed   = !local.use_custom_domain && var.certificate_arn == null

  # Certificate ARN to use
  certificate_arn = var.certificate_arn != null ? var.certificate_arn : (
    local.use_custom_domain ? aws_acm_certificate.custom_domain[0].arn : null
  )
}
```

Read this precisely: `use_self_signed` is `true` whenever custom-domain mode is off *and* no pre-existing certificate ARN was supplied — there is no third condition checking `var.environment` anywhere in this file, despite the module's own header comment (`infra/modules/acm/main.tf:6-8`) claiming "For dev/staging: Uses imported self-signed certificate... For prod: Uses ACM with DNS validation (fully automated)." The code doesn't gate on environment at all; it gates purely on whether a custom domain and/or an existing ARN were configured. A hypothetical `prod` environment that never set `enable_custom_domain = true` would get exactly the same self-signed path `dev` gets today. Worth flagging plainly as a documentation/code mismatch discovered by reading the file carefully, independent of anything else: the comment describes an aspiration, the `locals` block describes what actually happens.

### 3.2 Self-signed certificate generation — `tls_private_key` and `tls_self_signed_cert`

```hcl
# infra/modules/acm/main.tf:45-70
# Generate private key
resource "tls_private_key" "alb" {
  count     = local.use_self_signed ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 4096
}

# Generate self-signed certificate
resource "tls_self_signed_cert" "alb" {
  count           = local.use_self_signed ? 1 : 0
  private_key_pem = tls_private_key.alb[0].private_key_pem

  subject {
    common_name  = var.alb_dns_name
    organization = var.organization_name
    country      = var.country_code
  }

  validity_period_hours = 8760 # 365 days

  allowed_uses = [
    "key_encipherment",
    "digital_signature",
    "server_auth",
  ]
}
```

This is the HashiCorp `tls` provider doing entirely local, in-Terraform cryptography — no network call to any CA happens here at all. `tls_private_key.alb` generates a fresh 4096-bit RSA key pair purely as Terraform state; `tls_self_signed_cert.alb` takes that key and self-signs an X.509 certificate whose `common_name` is set to `var.alb_dns_name` — the ALB's own AWS-assigned DNS name (something like `astrix-dev-alb-123456789.us-east-1.elb.amazonaws.com`), not a real registered domain, because at this stage none exists. `validity_period_hours = 8760` is exactly 365 days with **no auto-renewal mechanism of any kind** — nothing in this module re-generates the certificate as it approaches expiry; a human has to re-run `terraform apply` (or `setup-https.sh`, §3.6) before day 365 or the certificate silently expires.

### 3.3 Writing the cert and key to local disk

```hcl
# infra/modules/acm/main.tf:72-83
# Save certificate to local file (for reference)
resource "local_file" "certificate" {
  count    = local.use_self_signed && var.save_certificate_locally ? 1 : 0
  content  = tls_self_signed_cert.alb[0].cert_pem
  filename = "${var.certificate_output_path}/alb-certificate.pem"
}

resource "local_file" "private_key" {
  count    = local.use_self_signed && var.save_certificate_locally ? 1 : 0
  content  = tls_private_key.alb[0].private_key_pem
  filename = "${var.certificate_output_path}/alb-private-key.pem"
}
```

These two `local_file` resources are exactly what the task brief anticipated: whenever `save_certificate_locally` is true (its default, `infra/modules/acm/variables.tf:44-48`) and the self-signed path is active, Terraform writes the raw PEM-encoded certificate and — far more sensitive — the raw PEM-encoded **private key** to plain files on whatever machine ran `terraform apply`. This is the exact mechanism the security section (§6) below is built around.

### 3.4 Importing the self-signed cert into ACM

```hcl
# infra/modules/acm/main.tf:89-104
resource "aws_acm_certificate" "self_signed" {
  count            = local.use_self_signed ? 1 : 0
  private_key      = tls_private_key.alb[0].private_key_pem
  certificate_body = tls_self_signed_cert.alb[0].cert_pem

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name        = "${var.environment}-alb-self-signed-cert"
    Environment = var.environment
    ManagedBy   = "Terraform"
    Type        = "Self-Signed"
  }
}
```

This is the resource that makes AstriX's setup unusual rather than merely "a local file nobody uses." `aws_acm_certificate` normally takes a `domain_name` argument and a `validation_method`, which is the DNS-validated shape everyone expects from ACM. Here it takes `private_key` and `certificate_body` instead — that's ACM's **certificate import** API, the same mechanism you'd use to bring an externally-purchased certificate (landscape option (a)) into ACM for use with an ALB. AstriX is using that import path to hand ACM a certificate it never issued and never validated — ACM accepts it, stores it, and hands back a perfectly normal-looking ARN, with no indication anywhere in that ARN that the certificate behind it was self-signed rather than CA-issued. `create_before_destroy` means a Terraform-triggered replacement (e.g. regenerating the underlying `tls_self_signed_cert` because the ALB's DNS name changed) provisions the new imported certificate before tearing down the old one, avoiding a window with no valid `certificate_arn` for the listener to reference.

### 3.5 The custom-domain path — standard DNS-validated ACM

```hcl
# infra/modules/acm/main.tf:110-164
resource "aws_acm_certificate" "custom_domain" {
  count             = local.use_custom_domain ? 1 : 0
  domain_name       = var.custom_domain_name
  validation_method = "DNS"

  subject_alternative_names = var.include_wildcard ? ["*.${var.custom_domain_name}"] : []

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name        = "${var.environment}-custom-domain-cert"
    Environment = var.environment
    ManagedBy   = "Terraform"
    Domain      = var.custom_domain_name
  }
}

data "aws_route53_zone" "custom_domain" {
  count        = local.use_custom_domain && var.route53_zone_id == null ? 1 : 0
  name         = var.custom_domain_name
  private_zone = false
}

resource "aws_route53_record" "cert_validation" {
  for_each = local.use_custom_domain ? {
    for dvo in aws_acm_certificate.custom_domain[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.route53_zone_id != null ? var.route53_zone_id : data.aws_route53_zone.custom_domain[0].zone_id
}

resource "aws_acm_certificate_validation" "custom_domain" {
  count                   = local.use_custom_domain ? 1 : 0
  certificate_arn         = aws_acm_certificate.custom_domain[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]

  timeouts {
    create = "10m"
  }
}
```

This block is exactly landscape option (b), textbook standard: request a certificate with `validation_method = "DNS"` (optionally covering a wildcard SAN if `include_wildcard` is true), look up the Route 53 hosted zone by name if one wasn't explicitly passed in, publish the CNAME validation record(s) ACM asks for via `aws_route53_record.cert_validation`, and then `aws_acm_certificate_validation` blocks Terraform (up to a 10-minute timeout) until ACM actually observes those records and flips the certificate to `ISSUED`. Every part of this — the domain-ownership proof, the eventual auto-renewal once issued (ACM auto-renews any certificate it validated via DNS as long as the validation record stays published) — is the fully automated, zero-human-touch path that landscape option (b) describes in the abstract. This is the module's real "graduate out of the placeholder" mechanism, already built and dormant, waiting only for `enable_custom_domain = true` and a registered domain name.

### 3.6 The dormant expiration-alert stub

```hcl
# infra/modules/acm/main.tf:170-184
# Alert if certificate expires in 30 days
resource "null_resource" "certificate_expiration_check" {
  count = var.enable_expiration_alerts ? 1 : 0

  triggers = {
    certificate_arn = local.certificate_arn
  }

  provisioner "local-exec" {
    command = <<-EOT
      echo "Certificate ARN: ${local.certificate_arn}"
      echo "Certificate will expire in approximately ${local.use_self_signed ? "365 days" : "automatic renewal"}"
    EOT
  }
}
```

Worth reading exactly, not just by name: despite being named `certificate_expiration_check`, this is a `local-exec` provisioner that fires exactly once, at `terraform apply` time, and simply `echo`s two lines of text to whatever terminal ran the apply. It is not a scheduled check, not a CloudWatch alarm, and it sends no notification anywhere (contrast with the real SNS-backed alarms covered in file 14) — and it's moot regardless, because the `dev` environment's module call explicitly sets `enable_expiration_alerts = false` (§3.7 below), so `count` evaluates to zero and the resource doesn't exist in the current deployment at all.

### 3.7 The `module "acm"` call in `dev`

```hcl
# infra/environments/dev/main.tf:291-310
module "acm" {
  source = "../../modules/acm"

  project_name             = var.project_name
  environment              = var.environment
  alb_dns_name             = module.alb.alb_dns_name
  organization_name        = "AstriX"
  country_code             = "US"
  save_certificate_locally = true
  certificate_output_path  = "${path.root}/../../certificates"

  # FIXED: Use correct variable names
  enable_custom_domain     = var.enable_alb_custom_domain
  custom_domain_name       = var.alb_custom_domain_name
  include_wildcard         = var.include_wildcard_cert
  certificate_arn          = var.alb_certificate_arn
  enable_expiration_alerts = false

  depends_on = [module.alb]
}
```

`alb_dns_name = module.alb.alb_dns_name` is the load-bearing line: the self-signed certificate's `common_name` (§3.2) is bound directly to the ALB module's output, which only exists once the ALB itself has been created — hence `depends_on = [module.alb]` explicitly ordering this module after it, on top of the implicit dependency the `module.alb.alb_dns_name` reference already creates. `certificate_output_path` is overridden here to `${path.root}/../../certificates` — resolving to `infra/certificates/` at the repository root of the `infra/` tree, one level up from `environments/dev` and one more up from `dev` itself — rather than the module's own `./certificates` default (`infra/modules/acm/variables.tf:50-54`), which is what actually determines where the two `.pem` files in §3.3 land on disk. `enable_expiration_alerts = false` confirms §3.6's dormant resource is inert in this environment as deployed today.

### 3.8 The HTTPS listener that consumes it

```hcl
# infra/environments/dev/main.tf:312-331
resource "aws_lb_listener" "https" {
  count = var.enable_https ? 1 : 0

  load_balancer_arn = module.alb.alb_arn
  port              = "443"
  protocol          = "HTTPS"
  ssl_policy        = var.ssl_policy
  certificate_arn   = module.acm.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = module.alb.target_group_arn
  }

  tags = merge(local.common_tags, {
    Name = "${var.project_name}-${var.environment}-https-listener"
  })

  depends_on = [module.acm]
}
```

This resource is a consumer of the ACM module's output, not part of it — its own listener mechanics, target-group forwarding, and why it lives at the root module instead of inside the ALB module belong to file 07, not here. What matters for this file is a single line: `certificate_arn = module.acm.certificate_arn` — the listener has no idea whether that ARN points at a self-signed import, a DNS-validated custom-domain certificate, or a pre-existing certificate passed straight through. From the listener's point of view, and from ACM's point of view once the certificate is imported or issued, all three are just "a certificate ARN in this account and region." The trust distinction only becomes visible the moment a real TLS client — a browser — tries to validate the chain, which is exactly what §4 traces next.

---

## 4. Request/Data Flow

Tracing what actually happens on a `terraform apply` of this part of the stack, and then what a browser experiences afterward:

1. **Module ordering.** `module.acm` carries `depends_on = [module.alb]` (`infra/environments/dev/main.tf:309`) on top of its implicit reference to `module.alb.alb_dns_name` — so the ALB (and its DNS name assignment) must exist before the ACM module can run at all. This directly determines what the self-signed certificate's `common_name` gets bound to: the ALB's own AWS-generated DNS name, not any name chosen ahead of time.
2. **Branch evaluation.** Inside the ACM module, `locals.use_custom_domain` and `locals.use_self_signed` (`infra/modules/acm/main.tf:31-39`) evaluate against whatever `enable_alb_custom_domain`, `alb_custom_domain_name`, and `alb_certificate_arn` currently hold in `dev`'s `terraform.tfvars`. With no custom domain configured and no existing ARN supplied, `use_self_signed` is `true`.
3. **Local cryptography.** `tls_private_key.alb` generates a 4096-bit RSA key entirely inside Terraform's own process — no AWS API call yet — and `tls_self_signed_cert.alb` self-signs a certificate for that key, scoped to `var.alb_dns_name` (`infra/modules/acm/main.tf:46-70`).
4. **Disk write.** Because `save_certificate_locally = true` (`infra/environments/dev/main.tf:299`), both `local_file.certificate` and `local_file.private_key` write PEM files to `infra/certificates/alb-certificate.pem` and `infra/certificates/alb-private-key.pem` (`infra/modules/acm/main.tf:73-83`, path resolved per §3.7) on whatever machine ran the apply.
5. **ACM import.** `aws_acm_certificate.self_signed` calls AWS's certificate-import API with that same key and certificate body (`infra/modules/acm/main.tf:89-104`), and ACM hands back a real ARN — no domain validation occurs anywhere in this branch, because import bypasses validation entirely; you're vouching for the certificate yourself by uploading it directly.
6. **Output threading.** `module.acm`'s `certificate_arn` output resolves to that imported certificate's ARN (`infra/modules/acm/outputs.tf:6-13`), and `aws_lb_listener.https` picks it up directly as `certificate_arn = module.acm.certificate_arn` (`infra/environments/dev/main.tf:319`), with `depends_on = [module.acm]` ensuring the listener isn't created before the certificate exists in ACM to reference.
7. **The browser's experience, self-signed default:** a client opening `https://<alb-dns-name>` completes a normal TLS handshake — the ALB presents the imported certificate, and encryption is fully functional — but the browser's certificate-chain validation fails immediately, because the signing "CA" is the certificate itself, which appears nowhere in the browser's trust store. The result is the standard interstitial warning (Chrome's "Your connection is not private," Firefox's "Warning: Potential Security Risk Ahead"), requiring an explicit manual override to proceed.
8. **The browser's experience, custom-domain path (if configured instead):** the same request against a real registered domain, once `aws_acm_certificate.custom_domain` has been DNS-validated and issued (`infra/modules/acm/main.tf:110-164`) and wired into the same listener, presents a certificate chaining up to Amazon's own trusted root CA (Amazon Trust Services) — which every major browser trusts out of the box — so the connection completes silently with a plain padlock and no interstitial at all.

---

## 5. Design Decisions & Tradeoffs

**Why generate and wire up a self-signed certificate at all, instead of just running the ALB on plain HTTP until a real domain exists?** The honest case for this is real: it means the HTTPS-listener code path, the `ssl_policy` configuration, the HTTP→HTTPS redirect behavior (`redirect_http_to_https`, `infra/environments/dev/variables.tf:636-640`), and every downstream consumer that assumes `https://` URLs (Google OAuth callback URLs, cookie `secure` flags, CORS origin checks) can all be built, deployed, and exercised end to end before a real domain is ever registered — there's never a "plaintext-only" phase in this buildout that later has to be retrofitted with TLS under time pressure. That's a genuinely disciplined ordering choice: get the HTTPS *shape* of the system right first, worry about who vouches for the certificate second.

**But be honest about what it doesn't buy you.** This pattern only "works" cleanly, in the sense of a real user hitting a real URL with no scary warning, once the placeholder is replaced by a real custom domain and a real DNS-validated certificate. Until that happens, every actual visitor to the raw ALB DNS name sees the self-signed trust warning described in §4 — the HTTPS-listener code is exercised and correct, but the trust relationship it's supposed to provide isn't there yet. This is a reasonable state for a pre-launch environment with no real users hitting it directly, and a real problem the moment that stops being true.

**The `ssl_policy` validation as a guardrail, not a security control.** `infra/environments/dev/variables.tf:621-634` declares:

```hcl
variable "ssl_policy" {
  description = "SSL policy for HTTPS listener"
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  validation {
    condition     = can(regex("^ELBSecurityPolicy-", var.ssl_policy))
    error_message = "ssl_policy must be a valid ELB security policy name, e.g. \"ELBSecurityPolicy-TLS13-1-2-2021-06\"."
  }
}
```

The regex only checks the *shape* of the string (`ELBSecurityPolicy-` prefix) — it does not, and by the variable's own comment cannot reasonably, enumerate AWS's actual list of valid policy names, since that list changes over time as AWS adds new policies and deprecates old ones. What it does catch is the single most common real mistake: someone passing a raw TLS version string (`"TLSv1.2"`) or a plain typo instead of an actual ELB policy identifier — a class of error that would otherwise surface only as an opaque AWS API rejection at `apply` time. It's a lightweight, honest guardrail against a specific mistake shape, not a policy-correctness validator.

**The default policy itself.** `ELBSecurityPolicy-TLS13-1-2-2021-06` is confirmed as the actual configured default (not just documented aspiration) at `infra/environments/dev/variables.tf:624`. This is one of AWS's modern, "FS" (forward-secrecy-preferring) policies that supports TLS 1.3 while remaining backward-compatible down to TLS 1.2, and it excludes the older, now-broken-or-deprecated protocol versions (SSLv3, TLS 1.0, TLS 1.1) and weak cipher suites entirely. Choosing a policy in this family, rather than one of AWS's older `ELBSecurityPolicy-2016-08`-style defaults, is a genuinely current (not just historically-reasonable) choice.

---

## 6. Security Considerations

**Locally-generated private keys on disk are the sharpest edge in this module.** `local_file.private_key` (`infra/modules/acm/main.tf:79-83`) writes the raw, unencrypted PEM private key to `infra/certificates/alb-private-key.pem` on whatever machine runs `terraform apply` — plain-text key material sitting on a filesystem, with no encryption at rest beyond whatever the host disk provides. `.gitignore` does correctly exclude this path — verified directly, not assumed:

```gitignore
# infra/.gitignore (repo root .gitignore:38-40)
infra/certificates/*.pem
*.pem
*.key
```

Three separate patterns cover it (a scoped path match, a broad `*.pem`, and a broad `*.key`), which is genuinely defense-in-depth against `.gitignore` itself — if the scoped `infra/certificates/*.pem` pattern were ever accidentally removed or narrowed, the blanket `*.pem`/`*.key` patterns would still catch these files. `git check-ignore -v` against both files currently on disk (`infra/certificates/alb-certificate.pem`, `infra/certificates/alb-private-key.pem`) confirms both are actively excluded by the `*.pem` rule right now, and `git status` shows neither as tracked or trackable.

That said, the underlying risk this configuration is guarding against is worth understanding generally, independent of whether it's ever actually happened here: a private key that lands in git history is a genuinely severe, hard-to-fully-remediate class of incident, for reasons worth internalizing as a rule rather than a one-off fear. First, `git rm` or even a force-push to overwrite a branch does not remove the blob from history — anyone who already cloned or fetched the repository at any point after the commit still has that blob locally, and any fork retains it permanently. Fully scrubbing a leaked secret from history requires rewriting every commit that touched it (`git filter-repo` or equivalent) and coordinating every clone/fork to discard their old history and re-clone — genuinely disruptive, and easy to miss a copy somewhere. Second, and more fundamentally, once a private key has been exposed at all, the only fully correct remediation is treating it as compromised permanently and rotating it — generating a brand-new key pair and certificate and retiring the old one — because there is no way to prove a leaked key *wasn't* copied by someone during the window it was exposed. Third, the actual attack a leaked TLS private key enables is concrete: whoever holds it can stand up a server presenting a certificate that is byte-for-byte indistinguishable from the real one for that domain (or, in this case, that ALB DNS name), which is precisely the setup for a man-in-the-middle attack against anyone who can be routed to the attacker's server instead of the real one. This is general private-key hygiene, true of any TLS key anywhere, not a description of anything that has or hasn't happened in this particular repository — but it's exactly why "the `.gitignore` pattern is correct" is a fact worth actively re-verifying (as this file just did) rather than a fact worth assuming.

**The self-signed certificate's browser-warning UX is itself a training risk, separate from the key-exposure risk above.** Every time a self-signed certificate produces a click-through trust warning — and that's the default, ongoing experience of hitting this ALB's DNS name directly today — it conditions whoever sees it (a developer, a QA tester, eventually a real user if the placeholder outlives its intended lifespan) to treat "click through the scary certificate warning" as a normal, expected step rather than an alarm signal. That habit is dangerous precisely because a *real* MITM attack, or a genuinely compromised/misconfigured certificate on a site that's supposed to be trusted, produces the exact same warning dialog — a user trained to reflexively dismiss it has had the browser's one loud, hard-to-miss defense against exactly that attack quietly disabled by repetition. This is a real cost of running a self-signed placeholder for any length of time beyond genuinely private, developer-only access, independent of whether the key itself ever leaks.

**The `ssl_policy`'s role in disabling weak protocol versions and ciphers.** Separate from who signed the certificate is what protocol versions and cipher suites the listener will even negotiate with — that's what `ssl_policy` governs (§5), and the configured default excludes SSLv3/TLS 1.0/TLS 1.1 and weak ciphers entirely, which matters regardless of which certificate path (self-signed or custom-domain) is in use: a modern `ssl_policy` on a self-signed certificate still refuses to negotiate a downgraded, crackable protocol version, even though the certificate itself carries no third-party trust.

---

## 7. Best Practice Check

Set against 2026 industry-standard certificate practice, the answer is unambiguous for the finished state and reasonably calibrated for the current state, and it's worth being precise about which of those two this repository actually is right now. A real, DNS-validated ACM certificate (or, outside AWS-native setups, Let's Encrypt via `cert-manager`) with automatic renewal is the unambiguous 2026 standard for anything beyond local development — no serious production service should be running on a certificate that requires a human to remember a renewal date, and none of the four landscape options from §1 seriously dispute that at this point; the debate in 2026 is which automated option fits your platform, not whether to automate at all.

A locally-generated self-signed certificate used as an explicit **placeholder** for a domain-less, pre-launch environment is a different question, and a reasonable, genuinely common stopgap that real projects use during initial buildout — the honest justification laid out in §5 (exercising the HTTPS code path before a domain exists) is a legitimate engineering reason, not a rationalization. What matters for calibrating judgment here is stating plainly, without hedging, that this repository's current default path is exactly that: a placeholder, not a finished state. It is not what a production service should still be running once real users depend on it, and the module doesn't pretend otherwise once you read past its header comment — `enable_custom_domain`, `custom_domain_name`, and the fully standard DNS-validation resources in §3.5 are the real, already-built graduation path out of the placeholder, and building that opt-in path in from the start — rather than hardcoding the self-signed behavior with no escape hatch — is the right way to have built this transitional capability. The gap worth naming honestly is that nothing in the module or its `dev` wiring currently *forces* that graduation to happen — there's no expiry-driven alert that actually fires (§3.6's `null_resource` is a dormant, non-notifying stub, and is explicitly disabled in `dev` regardless), so the placeholder persists exactly as long as nobody circles back to flip `enable_custom_domain` and register a domain, with no automated pressure pushing that forward.

---

## 8. Debug Drill

**Scenario A: users suddenly start seeing certificate trust warnings that weren't there before, on a URL that previously worked without one.** Start by determining which of the two very different failure classes this is, because the diagnosis and fix are unrelated. If the certificate in use has always been the self-signed placeholder and the warning is *new*, the most likely cause is that the ALB's DNS name changed — a new ALB, a re-created target group, or any Terraform operation that replaced the load balancer resource yields a new AWS-generated DNS name, and the self-signed certificate's `common_name` (bound to `var.alb_dns_name` at generation time, `infra/modules/acm/main.tf:58`) now doesn't match the hostname the browser is actually connecting to — producing a *second*, distinct warning (hostname mismatch) layered on top of the pre-existing untrusted-CA warning. Compare `module.alb.alb_dns_name`'s current value (`terraform output` or the AWS console) against the certificate's actual `common_name` (`openssl x509 -in infra/certificates/alb-certificate.pem -noout -subject` if the local file is present and current) to confirm. If instead a real custom-domain certificate was previously in place and the warning is new, check the certificate's actual expiry (`openssl x509 -in <cert> -noout -enddate`, or the ACM console's own status field) — a certificate that failed to auto-renew (commonly because its DNS validation record was removed or the hosted zone changed) will simply expire on schedule with no other symptom beforehand.

**Scenario B: an HTTPS listener fails to attach because a certificate ARN is invalid, expired, or in the wrong region.** The first thing to check, and the one most specific to how ALB (as opposed to CloudFront) consumes ACM certificates: **an ACM certificate used by an Application Load Balancer must exist in the same AWS region as the ALB itself** — this is the opposite of CloudFront, which requires any certificate it uses to live specifically in `us-east-1` regardless of which region the distribution otherwise serves from. A certificate ARN copied from the wrong region (easy to do if a team also runs a CloudFront distribution elsewhere in the same account, per file 10) will fail listener creation with a region-mismatch error that's easy to misread as a permissions problem at first glance — confirming the region segment of the ARN itself (`arn:aws:acm:<region>:...`) against the ALB's own region is the fastest way to rule this in or out. Second, check whether the `certificate_arn` the listener is actually referencing is stale — because `module.acm`'s `certificate_arn` output (`infra/modules/acm/outputs.tf:6-13`) is computed fresh from whichever of the three paths (existing ARN, custom-domain, self-signed) is currently active, a `terraform apply` that changes which path is active (for example, flipping `enable_custom_domain` on) produces a *new* ARN, and if any state (a manually-set variable, a cached value somewhere outside Terraform) still references the old one, the listener will point at a certificate ARN that either no longer exists or belongs to a certificate nobody intends to keep serving. Third, for the self-signed path specifically, confirm the certificate hasn't simply passed its 365-day `validity_period_hours` (§3.2) with nobody having re-applied to regenerate it — since nothing in this module renews it automatically, an expired self-signed certificate looks, from the listener's perspective, exactly like any other expired ACM certificate: the ARN still resolves, but TLS handshakes against it will fail once past the `notAfter` date.
