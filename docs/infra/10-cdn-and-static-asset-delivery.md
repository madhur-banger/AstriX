# CDN and Static Asset Delivery

> Part of the [AstriX engineering curriculum](../Architecture.md), under [Infra](./00-master-infra-architecture.md).

Every other file in this module so far has been about long-lived, stateful infrastructure — a VPC that exists for the life of the account, security groups that get tweaked rather than rebuilt, an ECS service that runs continuously. This file is about something that gets thrown away and rebuilt on every single deploy: the frontend's compiled static assets, and the machinery that gets a fresh copy of them in front of a user's browser as fast and as correctly as possible, worldwide, without ever routing a single one of those requests back through the backend's compute layer. It covers the real S3 bucket AstriX's React build lands in, the real CloudFront distribution in front of it, the actual mechanism that lets a client-side-routed single-page app survive a hard refresh on a deep link, and — the single most consequential decision documented anywhere in this module — why the dynamic, cookie-authenticated API is deliberately kept off that CDN entirely and hit directly on the load balancer instead.

---

## 1. The Landscape

"How do you get a frontend web app in front of a user's browser" has four genuinely distinct, still-current answers in production use today. They differ less in what the user sees and more in *where the rendering work happens*, *who operates the infrastructure*, and *how much of the CDN mechanics you have to reason about yourself*.

### (a) Traditional server-rendered hosting — a server renders and serves every request

The oldest and still extremely common pattern: a Node/Express process (or a PHP/Rails/Django app, or an Nginx box serving a server-rendered template) sits behind a single origin, and every request — `GET /`, `GET /dashboard`, `GET /login` — hits that server, which renders the response (or reads a file off local disk) and returns it. There is no CDN in the picture at all; every visitor, everywhere in the world, makes a round trip to wherever that one server physically lives.

```js
// illustrative Express server-rendered route — not AstriX code
app.get("/dashboard", (req, res) => {
  const html = renderDashboardPage(req.user); // rendered fresh, per request
  res.send(html);
});
```

**Tradeoffs:** this is the simplest mental model — one server, one deploy target, no cache-invalidation problem to reason about because nothing is cached at all. It's also the slowest option for a globally distributed audience, because every byte of every response travels the full network distance from the visitor to wherever that one server sits (often a single AWS region), and it puts unnecessary load on compute that could otherwise be reserved for actual dynamic work. It remains the right choice when pages genuinely must be rendered fresh per request with no meaningful caching opportunity, or when a team wants the absolute minimum number of moving pieces.

### (b) Object storage + CDN static hosting — upload a build, front it with a cache

Instead of a server rendering pages on demand, the frontend is *compiled once*, ahead of time, into a folder of plain files — HTML, JS, CSS, images — and that folder is uploaded to an object store (S3, Google Cloud Storage, Azure Blob Storage). A CDN (CloudFront, Cloudflare, Fastly, Akamai) sits in front of that bucket, caching those files at edge locations physically close to visitors around the world, so a user in Singapore isn't fetching bytes from a bucket in `us-east-1` on every request — they're fetching from a CloudFront edge node in Singapore that already has a cached copy. This is what AstriX does, and it is a completely generic pattern: it works for any static-site or SPA build output — a React app, a Vue app, a plain static marketing site, a Hugo or Jekyll-generated blog — not anything specific to React.

```bash
# illustrative — the generic shape of this pattern, any static build tool
npm run build                                   # produces ./dist (or ./build)
aws s3 sync ./dist s3://my-bucket --delete       # upload the compiled output
aws cloudfront create-invalidation --distribution-id ABC123 --paths "/*"
```

**Tradeoffs:** dramatically better global latency than (a) because most requests never leave the CDN's edge network to reach the origin bucket at all, and the origin (object storage) is nearly free to run since it's just serving static bytes with no compute attached. The cost is real operational surface you now own: you're responsible for cache invalidation correctness (stale content served after a deploy is a self-inflicted bug, not a platform failure), for wiring up SPA-routing fallbacks yourself (a static file host has no built-in concept of "serve index.html for any unknown path"), and for the CDN's own configuration — cache policies, origin access control, custom error pages — none of which is handed to you pre-configured the way a managed platform would.

### (c) Platform-as-a-service frontend hosts — Vercel, Netlify

Services like Vercel and Netlify implement essentially the same S3-plus-CDN mechanics under the hood — your build output still ends up in some object store behind some CDN — but the entire operational surface from (b) is abstracted away behind a managed product. You connect a Git repository, and every push triggers an automatic build and deploy, with a unique preview URL generated per pull request, cache invalidation handled transparently on every deploy, TLS certificates provisioned and renewed automatically, and zero Terraform or AWS console work required.

```bash
# illustrative — the entire deploy mechanism from the user's side
git push origin feature/new-dashboard
# Vercel/Netlify: builds automatically, deploys to a unique preview URL,
# invalidates caches, provisions TLS — no infra code involved
```

**Tradeoffs:** this is a real, honest convenience-versus-control tradeoff, not a strictly-better option. You give up owning the Terraform, the AWS account boundary, and fine-grained control over cache behavior, origin access policy, and cost attribution, in exchange for genuinely excellent developer experience (git-push-to-deploy, instant PR previews, zero infrastructure code to write or review) and a team that never has to debug a CloudFront invalidation. The cost side is real too: you're now dependent on a third party's pricing model and platform decisions, your infrastructure isn't expressed in the same Terraform that manages the rest of your AWS footprint (a second system to reason about, a second place secrets and configuration can live), and at meaningful scale these platforms can become more expensive than rolling your own S3+CloudFront setup. Rolling your own with Terraform, as AstriX does, is the right call when the frontend needs to live in the same account, IAM boundary, and Terraform state as the rest of the infrastructure it talks to.

### (d) Edge-rendering / edge-functions platforms — Cloudflare Workers/Pages, Vercel Edge Functions

The newest category runs actual server-side logic — not just static file serving — at CDN edge locations rather than in a single origin region. Cloudflare Workers and Pages Functions, and Vercel's Edge Functions/Middleware, let you execute JavaScript (or WASM) code at the same globally-distributed points of presence that cache your static assets, which is what makes server-side rendering (SSR) or per-request personalization *at the edge* possible — a page can be rendered close to the visitor instead of round-tripping to one origin region for every dynamic request.

```js
// illustrative Cloudflare Worker — not AstriX code
export default {
  async fetch(request) {
    const country = request.cf.country; // executed at the edge, close to the visitor
    return new Response(`Hello from ${country}`);
  },
};
```

**Tradeoffs:** this genuinely closes the latency gap for *dynamic* per-request work in a way that plain static-CDN hosting cannot, since the "server" logic itself now runs close to the user instead of in one region. It comes with real constraints, though — edge runtimes are typically a restricted JS/WASM environment (not full Node.js), cold-start and execution-time limits are tighter than a normal server process, and debugging distributed edge logic is harder than debugging one origin server. AstriX's frontend is a pure client-side-rendered SPA with no server-rendering step at all — the browser downloads a static bundle and renders everything client-side after that — so there is no per-request rendering work to push to the edge in the first place. Edge-functions platforms solve a problem (SSR-at-the-edge, per-request personalization) that this architecture simply doesn't have.

---

## 2. AstriX's Choice

AstriX uses approach (b): a static SPA build (the Vite-compiled React app) uploaded to a private S3 bucket, served to the world exclusively through a CloudFront distribution, with Origin Access Control locking the bucket down so CloudFront is the only thing that can ever read it directly. The dynamic backend API is a completely separate path — the Application Load Balancer in front of ECS Fargate, covered in [`07-load-balancing-and-traffic-routing.md`](./07-load-balancing-and-traffic-routing.md) — reached directly by the browser and never proxied through this CloudFront distribution at all. Both halves are provisioned by one Terraform module, `infra/modules/cloudfront_s3`.

---

## 3. AstriX Implementation

### 3.1 The S3 bucket — private, versioned, lifecycle-managed

```hcl
# infra/modules/cloudfront_s3/main.tf:37-45
resource "aws_s3_bucket" "frontend" {
  bucket        = var.bucket_name != null ? var.bucket_name : "${var.project_name}-${var.environment}-frontend"
  force_destroy = var.force_destroy

  tags = merge(var.common_tags, {
    Name = "${var.project_name}-${var.environment}-frontend"
    Type = "frontend-hosting"
  })
}
```

Immediately after creating the bucket, the module blocks every public-access path AWS exposes:

```hcl
# infra/modules/cloudfront_s3/main.tf:47-55
# Block all public access - CloudFront will access via OAC
resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
```

Versioning is on by default (used purely for rollback capability — the ability to restore a previous build's objects, not a public-facing feature), and encryption defaults to AES256 unless a customer-managed KMS key is supplied:

```hcl
# infra/modules/cloudfront_s3/main.tf:57-77
# Enable versioning for rollback capability
resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  versioning_configuration {
    status = var.enable_versioning ? "Enabled" : "Suspended"
  }
}

# Server-side encryption
resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn != null ? "aws:kms" : "AES256"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = var.kms_key_arn != null
  }
}
```

Because every deploy re-uploads the entire build and versioning keeps every prior object version around, the bucket would grow unbounded without a cleanup policy. The lifecycle configuration handles that:

```hcl
# infra/modules/cloudfront_s3/main.tf:79-113
# Lifecycle rules for cost optimization
resource "aws_s3_bucket_lifecycle_configuration" "frontend" {
  count  = var.enable_lifecycle_rules ? 1 : 0
  bucket = aws_s3_bucket.frontend.id

  rule {
    id     = "cleanup-old-versions"
    status = "Enabled"

    # Empty filter = apply to every object. The AWS provider warns that a
    # rule with neither `filter` nor `prefix` will become a hard error in a
    # future version - this makes "applies to everything" explicit instead
    # of implicit.
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "cleanup-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}
```

`noncurrent_version_expiration_days` defaults to 30 (`variables.tf:65-69`) — a deleted-or-overwritten object's *previous* version sticks around for 30 days before S3 permanently expires it, which is the actual rollback window this bucket gives you, not an indefinite one.

The CORS block exists because a browser loading the SPA's JS bundle may need to fetch certain assets (fonts, source maps, worker scripts) cross-origin in some deployment shapes, and CloudFront/S3 will refuse those fetches without an explicit CORS policy:

```hcl
# infra/modules/cloudfront_s3/main.tf:115-126
# CORS configuration for SPA
resource "aws_s3_bucket_cors_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = var.cors_allowed_origins
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}
```

`allowed_origins` is driven entirely by `var.cors_allowed_origins`, and the module's own variable declaration is explicit that this should never default to a wildcard:

```hcl
# infra/modules/cloudfront_s3/variables.tf:71-75
variable "cors_allowed_origins" {
  description = "Allowed origins for CORS. No permissive default - callers must opt in with real origins."
  type        = list(string)
  default     = []
}
```

Whether the deployed environment actually honors that intent is checked in §6 below.

### 3.2 Origin Access Control — the bucket is not public

```hcl
# infra/modules/cloudfront_s3/main.tf:133-139
resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${var.project_name}-${var.environment}-oac"
  description                       = "OAC for ${var.project_name} frontend"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
```

OAC is the modern (2022+) replacement for the older Origin Access Identity mechanism: it makes CloudFront sign every request to the S3 origin with SigV4, and the bucket policy then grants access only to requests carrying that signature *and* originating from this specific distribution:

```hcl
# infra/modules/cloudfront_s3/main.tf:145-168
resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontServicePrincipal"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.frontend.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.frontend.arn
          }
        }
      }
    ]
  })

  depends_on = [aws_cloudfront_distribution.frontend]
}
```

Combined with the public-access-block from §3.1, this means: no ACL grants public read, no bucket policy grants `Principal: "*"`, and the `Condition` scopes the grant to *this exact distribution's ARN* — a different CloudFront distribution, even one in the same AWS account, could not read this bucket. The bucket is reachable only through CloudFront.

### 3.3 The CloudFront distribution

The distribution resource carries a header comment that is, itself, primary documentation of the module's central architectural decision:

```hcl
# infra/modules/cloudfront_s3/main.tf:236-249
# -----------------------------------------------------------------------------
# CLOUDFRONT DISTRIBUTION
# -----------------------------------------------------------------------------
#
# Deliberately frontend-only: the API is NOT routed through this
# distribution. Caching a cookie-authenticated API response at the edge
# risks serving one user's response to another - see infra/README.md and
# scripts/update-urls.sh for the full rationale. Earlier revisions of this
# module wired an /api/* behavior to the ALB origin anyway (dead, unused
# code that contradicted the documented architecture); it's been removed
# rather than left as latent, contradictory surface. If a future need
# genuinely requires proxying the API through CloudFront, reintroduce it
# deliberately alongside updated docs, not as a default.
```

The origin block points at the S3 bucket through OAC, not at anything else:

```hcl
# infra/modules/cloudfront_s3/main.tf:250-266
resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${var.project_name}-${var.environment} frontend distribution"
  default_root_object = "index.html"
  price_class         = var.price_class
  aliases             = var.domain_name != null ? [var.domain_name] : []
  web_acl_id          = var.web_acl_id

  # ---------------------------------------------------------------------------
  # ORIGIN: S3 BUCKET (Frontend Static Files)
  # ---------------------------------------------------------------------------
  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "S3-${aws_s3_bucket.frontend.id}"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }
```

There is exactly one origin in this whole distribution — the S3 bucket. There is no second origin block pointing at the ALB anywhere in this file (confirmed by reading the resource start to finish); the header comment's claim that such wiring was removed is accurate to the current code.

`price_class` defaults to the cheapest tier:

```hcl
# infra/modules/cloudfront_s3/variables.tf:81-85
variable "price_class" {
  description = "CloudFront price class (PriceClass_100, PriceClass_200, PriceClass_All)"
  type        = string
  default     = "PriceClass_100" # US, Canada, Europe only (cheapest)
}
```

`PriceClass_100` only serves cached content from CloudFront's North America and Europe edge locations — a visitor in, say, Singapore or São Paulo still gets HTTPS and caching, but from a farther-away edge node than the full `PriceClass_All` tier would use, in exchange for meaningfully lower cost. For a project at AstriX's traffic scale that's a reasonable default, not a functional gap.

### 3.4 SPA routing: two overlapping mechanisms

A single-page app has exactly one real file on disk that matters for routing purposes — `index.html`. Every other "page" (`/dashboard`, `/projects/123`, `/settings`) is a route React Router resolves *client-side*, inside JavaScript that's already loaded — there is no `dashboard.html` file in the S3 bucket for CloudFront or S3 to find. Left unhandled, a hard refresh or a direct link to any of those routes gets a 403/404 from S3, because as far as S3 is concerned that object genuinely does not exist.

AstriX's module implements two separate mechanisms that both address this, working at two different points in the request path.

**Mechanism one — a CloudFront Function that rewrites the request *before* it ever reaches the origin:**

```hcl
# infra/modules/cloudfront_s3/main.tf:398-429
resource "aws_cloudfront_function" "spa_routing" {
  count   = var.enable_spa_routing ? 1 : 0
  name    = "${var.project_name}-${var.environment}-spa-routing"
  runtime = "cloudfront-js-2.0"
  comment = "SPA routing - redirect all paths to index.html"
  publish = true
  code    = <<-EOF
function handler(event) {
    var request = event.request;
    var uri = request.uri;

    // Check if the URI has a file extension
    if (uri.includes('.')) {
        return request;
    }

    // Check if URI ends with /
    if (uri.endsWith('/') && uri !== '/') {
        request.uri = '/index.html';
        return request;
    }

    // For all other paths without extension, serve index.html
    // This enables client-side routing
    if (!uri.includes('.')) {
        request.uri = '/index.html';
    }

    return request;
}
EOF
}
```

This function is attached to the default cache behavior's `viewer-request` event, meaning it runs at CloudFront's edge for every incoming request, before CloudFront even checks its cache or reaches out to S3:

```hcl
# infra/modules/cloudfront_s3/main.tf:271-291
default_cache_behavior {
  allowed_methods  = ["GET", "HEAD", "OPTIONS"]
  cached_methods   = ["GET", "HEAD"]
  target_origin_id = "S3-${aws_s3_bucket.frontend.id}"

  # Use managed caching policy for static assets
  cache_policy_id            = local.cloudfront_cache_policies.optimized
  response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id

  viewer_protocol_policy = "redirect-to-https"
  compress               = true

  # Function associations for SPA routing
  dynamic "function_association" {
    for_each = var.enable_spa_routing ? [1] : []
    content {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_routing[0].arn
    }
  }
}
```

Its logic is a simple heuristic: if the requested URI contains a `.` (i.e., looks like `main.a1b2c3.js` or `logo.png` — an actual static file), leave the request alone and let it hit S3 normally; otherwise, assume it's an application route and rewrite `request.uri` to `/index.html` before CloudFront even looks at its cache or contacts the origin. For `GET /dashboard`, this function silently turns the request into `GET /index.html` at the edge, S3 returns that object with a normal 200, and the browser never sees an error at all.

**Mechanism two — `custom_error_response` blocks that catch anything the function's heuristic misses:**

```hcl
# infra/modules/cloudfront_s3/main.tf:338-355
# ---------------------------------------------------------------------------
# CUSTOM ERROR RESPONSES (SPA ROUTING SUPPORT)
# ---------------------------------------------------------------------------
# 403 → index.html (for SPA client-side routing)
custom_error_response {
  error_code            = 403
  response_code         = 200
  response_page_path    = "/index.html"
  error_caching_min_ttl = 0
}

# 404 → index.html (for SPA client-side routing)
custom_error_response {
  error_code            = 404
  response_code         = 200
  response_page_path    = "/index.html"
  error_caching_min_ttl = 0
}
```

This is the fallback net: if a request ever *does* reach S3 and S3 responds with either a 403 (the realistic outcome here, since the bucket has no public read access — an OAC-protected bucket returns 403, not 404, for a missing key) or a 404, CloudFront intercepts that error response and serves `/index.html` instead, rewriting the status code to a plain 200 so the browser treats it as a normal successful page load rather than an error page. `error_caching_min_ttl = 0` means CloudFront doesn't cache that *error* itself, so a transient S3 hiccup on one request doesn't get remembered and replayed to the next visitor.

The two mechanisms are complementary rather than redundant: the CloudFront Function catches the common case entirely at the edge, cheaply, before any origin round trip; the error-response fallback catches whatever the function's "does the URI contain a dot" heuristic doesn't handle correctly — for instance a route that legitimately contains a period (a version string, a decimal id) that the function would mistake for a static-file request and pass through unmodified, only for S3 to 403 it, at which point the error-response mapping still rescues it into a 200.

Two more `ordered_cache_behavior` blocks exist purely to make path-based routing for build-output files explicit:

```hcl
# infra/modules/cloudfront_s3/main.tf:293-336
ordered_cache_behavior {
  path_pattern     = "/assets/*"
  allowed_methods  = ["GET", "HEAD", "OPTIONS"]
  cached_methods   = ["GET", "HEAD"]
  target_origin_id = "S3-${aws_s3_bucket.frontend.id}"

  cache_policy_id            = local.cloudfront_cache_policies.optimized
  response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id

  viewer_protocol_policy = "redirect-to-https"
  compress               = true
}

ordered_cache_behavior {
  path_pattern     = "*.js"
  allowed_methods  = ["GET", "HEAD"]
  cached_methods   = ["GET", "HEAD"]
  target_origin_id = "S3-${aws_s3_bucket.frontend.id}"

  cache_policy_id            = local.cloudfront_cache_policies.optimized
  response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id

  viewer_protocol_policy = "redirect-to-https"
  compress               = true
}

ordered_cache_behavior {
  path_pattern     = "*.css"
  allowed_methods  = ["GET", "HEAD"]
  cached_methods   = ["GET", "HEAD"]
  target_origin_id = "S3-${aws_s3_bucket.frontend.id}"

  cache_policy_id            = local.cloudfront_cache_policies.optimized
  response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id

  viewer_protocol_policy = "redirect-to-https"
  compress               = true
}
```

Worth reading these carefully rather than trusting their section comment: the comment above `/assets/*` in the source calls it "Static Assets with Long Cache," but every one of these blocks — the default behavior included — points at the exact same managed cache policy, `local.cloudfront_cache_policies.optimized`:

```hcl
# infra/modules/cloudfront_s3/main.tf:26-30
locals {
  cloudfront_cache_policies = {
    optimized = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
    disabled  = "413f83b7-8c41-4bb7-9f3f-3f83c2d3f01b" # Managed-CachingDisabled
  }
}
```

There is no separate, longer-TTL policy actually applied to `/assets/*` or `*.js`/`*.css` versus `index.html` — all four behaviors share `Managed-CachingOptimized`, an AWS managed policy with the same default/max TTL bounds for everything that matches. The ordered behaviors' practical effect today is routing clarity (each asset type has an explicit, named path match) rather than a genuinely different caching regime; see §7 for what a differentiated TTL setup would look like and why it would matter more at higher traffic.

Geo-restriction, the SSL certificate, and access logging are all present as fully optional, off-by-default knobs:

```hcl
# infra/modules/cloudfront_s3/main.tf:357-387
restrictions {
  geo_restriction {
    restriction_type = var.geo_restriction_type
    locations        = var.geo_restriction_locations
  }
}

viewer_certificate {
  acm_certificate_arn            = var.acm_certificate_arn
  ssl_support_method             = var.acm_certificate_arn != null ? "sni-only" : null
  minimum_protocol_version       = var.acm_certificate_arn != null ? "TLSv1.2_2021" : null
  cloudfront_default_certificate = var.acm_certificate_arn == null
}

dynamic "logging_config" {
  for_each = var.enable_logging && var.log_bucket != null ? [1] : []
  content {
    bucket          = var.log_bucket
    prefix          = var.log_prefix != null ? var.log_prefix : "${var.project_name}/${var.environment}/cloudfront/"
    include_cookies = var.log_include_cookies
  }
}
```

`geo_restriction_type` defaults to `"none"` (`variables.tf:131-135`) — no country blocking today. When `acm_certificate_arn` is unset, CloudFront falls back to its own default `*.cloudfront.net` certificate rather than a custom domain — this module doesn't re-implement ACM's certificate issuance mechanics itself; it just accepts an ARN, which [`08-tls-and-certificate-management.md`](./08-tls-and-certificate-management.md) covers in depth. Access logging is off by default (`enable_logging = false`, `variables.tf:147-151`) and only activates once both a flag and a destination bucket are supplied.

### 3.5 Wiring it up in the `dev` environment

```hcl
# infra/environments/dev/main.tf:424-452
module "cloudfront_s3" {
  source = "../../modules/cloudfront_s3"

  project_name                       = var.project_name
  environment                        = var.environment
  bucket_name                        = var.frontend_bucket_name
  force_destroy                      = var.frontend_force_destroy
  enable_versioning                  = var.frontend_enable_versioning
  kms_key_arn                        = var.frontend_kms_key_arn
  enable_lifecycle_rules             = var.frontend_enable_lifecycle_rules
  noncurrent_version_expiration_days = var.frontend_noncurrent_version_expiration_days
  cors_allowed_origins               = var.frontend_cors_allowed_origins
  price_class                        = var.cloudfront_price_class
  enable_spa_routing                 = var.cloudfront_enable_spa_routing
  domain_name                        = var.frontend_domain_name
  acm_certificate_arn                = var.frontend_acm_certificate_arn
  route53_zone_id                    = var.frontend_route53_zone_id
  web_acl_id                         = var.cloudfront_web_acl_id
  content_security_policy            = var.cloudfront_content_security_policy
  geo_restriction_type               = var.cloudfront_geo_restriction_type
  geo_restriction_locations          = var.cloudfront_geo_restriction_locations
  enable_logging                     = var.cloudfront_enable_logging
  log_bucket                         = var.cloudfront_log_bucket
  log_prefix                         = var.cloudfront_log_prefix
  log_include_cookies                = var.cloudfront_log_include_cookies

  common_tags = local.common_tags
  depends_on  = [module.alb, module.acm]
}
```

`depends_on = [module.alb, module.acm]` is explicit rather than inferred — nothing inside this module block actually references an `alb` or `acm` output attribute, so without the explicit `depends_on`, Terraform's implicit graph would have no reason to sequence this module after either of them. It's the kind of ordering guard that outlives the reason it was originally added; the safest reading is that it's a conservative sequencing choice (don't stand up the frontend distribution before the ALB/cert path it will eventually need to be told about, e.g. for CORS/callback URLs computed elsewhere in this same file) rather than a load-bearing data dependency.

### 3.6 CI: sync and invalidate

```yaml
# .github/workflows/deploy-frontend.yml:77-87
- name: Sync to S3
  working-directory: client
  run: |
    aws s3 sync dist/ s3://$S3_BUCKET/ --delete

- name: Invalidate CloudFront
  run: |
    aws cloudfront create-invalidation \
      --distribution-id ${{ steps.cloudfront.outputs.distribution_id }} \
      --paths "/*"
    echo "✅ Frontend deployed and cache invalidated!"
```

---

## 4. Request/Data Flow

### Flow one: shipping a new frontend build

1. A push to `main` touching `client/**` triggers `.github/workflows/deploy-frontend.yml`.
2. The workflow authenticates to AWS via OIDC (no long-lived keys), then looks up the CloudFront distribution ID by matching its origin domain name against the known S3 bucket name — it doesn't hardcode a distribution ID, it discovers it (`.github/workflows/deploy-frontend.yml:36-52`).
3. It fetches the backend's public URL from SSM Parameter Store: `aws ssm get-parameter --name "/astrix/dev/VITE_API_BASE_URL"` (`deploy-frontend.yml:54-58`). This value was itself written to Parameter Store earlier by Terraform/`update-urls.sh`, computed from the ALB's DNS name — not CloudFront's.
4. `npm run build` runs with `VITE_API_BASE_URL` set as an environment variable (`deploy-frontend.yml:71-75`). This is the critical step to understand precisely: Vite's build step performs a literal find-and-replace of every `import.meta.env.VITE_API_BASE_URL` reference in the source with the actual string value, at build time, before a single file is written to `dist/`. The resulting JS bundle contains the API's URL as a hardcoded string constant, baked into the file bytes themselves — not read from any environment variable, config endpoint, or runtime value once that bundle reaches a browser.
5. `aws s3 sync dist/ s3://$S3_BUCKET/ --delete` uploads the new build. The `--delete` flag is what makes this a true mirror rather than an accumulation: any object present in the bucket from a *previous* build that isn't part of the *current* `dist/` output (a renamed hashed chunk, a since-removed asset) gets deleted from S3, not just left alongside the new files forever.
6. `aws cloudfront create-invalidation --distribution-id ... --paths "/*"` purges every cached object at every CloudFront edge location globally. Without this step, a user whose nearest edge node cached yesterday's `index.html` (or, worse, yesterday's hashed JS chunk under a URL that a stale cached `index.html` still references) would keep receiving the old build indefinitely, until that edge's cache naturally expired on its own TTL — which, for `Managed-CachingOptimized`, can be a meaningfully long window.

The build-time-versus-runtime distinction in step 4 has an operational consequence worth stating plainly: if the API's URL ever changes — a new ALB, a migration to a custom domain, an environment cutover — the frontend cannot simply be told about the new URL. There is no config file, no runtime fetch, no environment variable read *by the browser* at any point after the JS has been built. The only way to get a new API URL in front of users is to rebuild the frontend from source with the new value baked in, and redeploy the whole bundle. A pure infrastructure change on the backend side (new ALB DNS name) requires a frontend CI run to actually take effect for users — an explicit coupling between "infra changed" and "frontend must redeploy" that a runtime-config approach wouldn't have.

### Flow two: a user's browser hits a client-side route

1. A user's browser requests `https://<cloudfront-domain>/projects/42` — a route that exists only inside the React Router configuration running in already-loaded JavaScript, not as a file in S3.
2. The request reaches a CloudFront edge location. Because `enable_spa_routing` is true, the `spa_routing` CloudFront Function runs first, on `viewer-request`. It inspects the URI `/projects/42`: no `.` in it, doesn't end in `/`, so it rewrites `request.uri` to `/index.html` before CloudFront does anything else with the request.
3. CloudFront checks its cache for `/index.html` at this edge location. On a cache hit (likely, since `index.html` is a small, frequently-requested object), it's served immediately with no origin round trip at all. On a miss, CloudFront signs a request with SigV4 (via OAC) and fetches `/index.html` from the private S3 bucket, caches it per the `Managed-CachingOptimized` policy, and serves it.
4. The browser receives `index.html` with a 200 status and the URL bar still showing `/projects/42` (the rewrite happened at CloudFront, not via an HTTP redirect, so the browser's address bar is untouched). The HTML references the built JS bundle, the browser downloads and executes it, React Router reads `window.location.pathname` (`/projects/42`), and renders the matching client-side route. From the user's perspective nothing ever "failed" — they never see an error page, because the CloudFront Function intercepted the mismatch before S3 was ever asked about a `/projects/42` object that doesn't exist.
5. If, for some reason, the request instead reached S3 directly with an unresolved path (the Function's heuristic failing to catch an edge case, or `enable_spa_routing` disabled), S3 would answer with a 403 (OAC-protected bucket, no such key — an OAC bucket denies rather than reveals nonexistence, which is why 403 is the realistic status here, not 404). CloudFront's `custom_error_response` block for 403 then intercepts that response, discards the 403, and serves `/index.html` with a rewritten 200 status instead — the second, fallback layer of the same SPA-routing guarantee.

**Contrast: an API request never goes near any of this.** `https://<alb-dns-name>/api/projects` goes directly from the browser to the Application Load Balancer — no CloudFront edge, no cache check, no OAC, no S3, no CloudFront Function. It's a completely separate origin, a completely separate hostname, and a completely separate Terraform module (`alb` + `ecs`) from everything described above. The next section explains precisely why that separation is deliberate.

---

## 5. Design Decisions & Tradeoffs

**The central decision: `/api/*` is never proxied through CloudFront.** A CDN's entire value proposition is caching a response once and replaying that same cached response to many subsequent viewers from an edge location, without going back to the origin. That's exactly the right model for the frontend's static JS/CSS/HTML — those bytes are identical for every visitor, so caching and replaying them is pure upside. It is exactly the *wrong* model for an authenticated API response, because that response is not identical for every visitor: `GET /api/user/current`, `GET /api/projects` — these return a different body *per caller*, keyed off a session cookie or bearer token the CDN has no reliable way to fold into its cache key correctly. AstriX's own documentation states this directly, and it's worth quoting rather than paraphrasing, since it's the module's own stated rationale:

> "The API is **not** proxied through CloudFront — it's hit directly on the ALB. This is deliberate (see `infra/scripts/update-urls.sh`'s header comment): CloudFront caching dynamic, cookie-authenticated API responses risks leaking one user's response to another."
> — `infra/README.md:13`

And from the script itself:

```bash
# infra/scripts/update-urls.sh:17-20
# Why NOT put API behind CloudFront:
# 1. CloudFront caches responses - can leak auth cookies to other users
# 2. CloudFront normalizes/strips headers - breaks auth flows
# 3. CloudFront is for static content, ALB is for dynamic APIs
```

Walk through concretely what "leak one user's response to another" means in practice. Suppose a CDN cache key were configured (even inadvertently, via a permissive default cache policy) to key only on the URL path `/api/projects`, ignoring the `Cookie` or `Authorization` header entirely. User A, logged in, requests `/api/projects` and gets their own project list back; CloudFront caches that response under the key `/api/projects`. Moments later, User B — a completely different, unrelated account — requests the *same URL path*, `/api/projects`, from an edge node that already has User A's response cached. If the cache key doesn't distinguish the two requests, CloudFront serves User B User A's cached project list, cookies-and-all-adjacent context notwithstanding, because as far as the cache is concerned it's the same URL and it already has an answer. This is a well-documented, real class of CDN misconfiguration — caching a personalized response under a cache key that doesn't vary by the identity that made the request — and AstriX avoids the entire failure mode structurally, not by carefully tuning a cache policy to exclude cookies from the key. There is no cache policy to get right here, because there is no CloudFront behavior routing to the API at all.

**What this decision costs: two hostnames, and CORS becomes load-bearing.** Because the frontend is served from the CloudFront domain (or a future custom domain aliased to it) and the API is served from the ALB's own DNS name — two structurally different origins from a browser's point of view — every API call the frontend makes is, by definition, a cross-origin request. The backend must have a CORS policy that explicitly allows the CloudFront origin to call it, and — since AstriX's auth model uses cookies (`cookie_domain = module.alb.alb_dns_name`, `infra/environments/dev/main.tf:94-95`) — that CORS configuration has to correctly handle credentialed cross-origin requests, which is a stricter, more error-prone case than same-origin cookie handling. This file doesn't re-litigate the backend's actual CORS middleware configuration (that's [`03-middleware-and-request-pipeline.md`](../backend/03-middleware-and-request-pipeline.md)'s territory); the point to internalize here is that the two-domain split isn't free — it's the direct, structural cost of the decision to keep the API off the CDN, and it has to be paid correctly somewhere in the backend's own request pipeline for auth to work at all.

**Why build-time, not runtime, API-URL injection — and what that costs.** An alternative design would have the frontend fetch its API URL from some runtime source — a small `/config.json` the app requests on load, or a global variable injected into `index.html` by a server-side templating step — so the same built JS bundle could be pointed at different API URLs without rebuilding. AstriX doesn't do this: `VITE_API_BASE_URL` is resolved once, at `npm run build` time, and becomes a literal string inside the shipped JS. The upside is simplicity — no extra runtime fetch, no additional moving part, no risk of that config endpoint itself becoming a target or a point of failure, and the value is guaranteed consistent for the entire lifetime of that particular build (no chance of a config endpoint returning one value to one tab and a different value to another mid-session). The cost, named plainly, is the operational coupling already walked through in §4: any change to the API's URL — a new custom domain, a load balancer replacement, an environment cutover — cannot take effect by touching infrastructure alone. It requires triggering `deploy-frontend.yml` to rebuild and re-upload the entire frontend, purely to bake in a new string constant that has nothing to do with any actual code change. For a single-environment setup with an infrequently-changing API URL, that's a reasonable, low-friction tradeoff; it would become a real annoyance in a setup that rotates backend URLs frequently (e.g., certain blue-green or multi-region cutover strategies), where a runtime-config approach would decouple "the API moved" from "the frontend needs a new build."

---

## 6. Security Considerations

**The API/CDN separation described above is, itself, a security decision, not merely an architectural preference.** It's worth restating that framing explicitly rather than letting it live only in §5: "don't cache a per-user, cookie-authenticated response at a shared edge location" is a named, recognized class of CDN misconfiguration with real, documented incidents behind it industry-wide (a cache-poisoning-adjacent failure where one user's personalized response becomes another user's response). AstriX's choice to keep `/api/*` off CloudFront entirely is a deliberate avoidance of that whole vulnerability class — not something bolted on after an incident, but a structural decision baked into the module from the start, per its own header comment in §3.3.

**S3 bucket exposure: private, via OAC — not a gap.** This is worth confirming from the actual resources rather than assuming either way, since it's exactly the kind of thing that's easy to get wrong. Checking the real code: `aws_s3_bucket_public_access_block.frontend` sets all four public-access blocking flags to `true` (`main.tf:48-55`); there is no bucket ACL resource granting public read anywhere in this file; and the only bucket policy statement (`main.tf:145-168`) grants `s3:GetObject` exclusively to the `cloudfront.amazonaws.com` service principal, scoped by a `Condition` to this specific distribution's ARN. Combined with the `aws_cloudfront_origin_access_control` resource and the origin block's `origin_access_control_id` reference, this is Origin Access Control done correctly — the bucket has no public read path at all, and only requests signed by this exact CloudFront distribution can retrieve objects from it. This matches 2026 best practice cleanly; there's no gap to report here.

**S3 CORS: the module's own default is safe, but the deployed value in `dev` is not.** The module variable's description states the intent outright — "No permissive default - callers must opt in with real origins" — and its default is an empty list (`variables.tf:71-75`). The `.tfvars.example` template honors that intent (`frontend_cors_allowed_origins = []`). But the real, currently-applied `terraform.tfvars` for the `dev` environment sets `frontend_cors_allowed_origins = ["*"]` — a wildcard, allowing any origin whatsoever to make CORS-permitted `GET`/`HEAD` requests against the bucket's objects. Since the CORS rule here only covers `GET`/`HEAD` and doesn't carry credentials, the practical blast radius is narrower than a wildcard on a credentialed endpoint would be — but it's a direct, real contradiction of the module's own stated no-permissive-default design intent, findable by simply diffing the tfvars file against its own example template and the variable's description. Worth tightening to the actual CloudFront/custom-domain origin(s) once those are finalized, rather than leaving the wildcard in place indefinitely.

**WAF: not attached, on either public origin — a consistent pattern, not unique to this module.** `web_acl_id` defaults to `null` (`variables.tf:119-123`), it's wired straight through from `var.cloudfront_web_acl_id` in the `dev` environment (`environments/dev/main.tf:441`), and that variable is itself set to `null` in the real `terraform.tfvars` (`terraform.tfvars:231`). So the plumbing for attaching an AWS WAF Web ACL to this CloudFront distribution exists and is fully wired, but no Web ACL is actually attached in the deployed environment — meaning CloudFront in front of the frontend has no L7, content-aware inspection layer (no filtering for known-bad request signatures, no rate limiting at this layer) any more than the ALB does, a gap [`03-security-groups-and-network-segmentation.md`](./03-security-groups-and-network-segmentation.md) already covers in detail for the ALB side. Worth naming once, clearly, exactly because it's the same absence showing up on *both* of AstriX's public-facing origins rather than two unrelated gaps — a consistent "no WAF anywhere yet" posture across the whole edge, not a CloudFront-specific oversight.

**Security response headers are attached, and worth a brief mention even though this file isn't the headers deep-dive.** Every cache behavior in this distribution attaches `aws_cloudfront_response_headers_policy.security_headers` (`main.tf:175-233`), which sets `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, a `Referrer-Policy` of `strict-origin-when-cross-origin`, HSTS when a custom domain is configured, and an optional CSP when one is supplied — a reasonable baseline hardening layer sitting entirely at the CDN edge, independent of whatever headers the origin itself would have set.

---

## 7. Best Practice Check

S3-plus-CloudFront with cache invalidation triggered on every deploy remains squarely the standard, industry-recognized pattern for static-site/SPA hosting at 2026 — it isn't a dated approach being carried forward out of inertia. Origin Access Control specifically (as opposed to a public bucket, or the older Origin Access Identity mechanism it replaced) is the current best-practice access model, and AstriX's implementation matches it correctly, as confirmed in §6.

Where a genuinely more scalable pattern exists — worth naming honestly rather than implying AstriX's approach is simply outdated — is in how cache invalidation is triggered. AstriX invalidates `/*` on every single deploy: every object at every edge location is purged, unconditionally, whether or not it actually changed. At AstriX's traffic scale this is a perfectly reasonable, simple, and correct approach — CloudFront invalidations for the first 1,000 paths per month are free, and a full-distribution invalidation on each deploy guarantees correctness with essentially zero engineering effort. A higher-traffic site would typically move to a **versioned/immutable asset filenames plus differentiated TTL** pattern instead: build tools like Vite already emit content-hashed filenames for JS/CSS chunks (`main.a1b2c3d4.js`) specifically so that those files can be served with an extremely long, effectively-immutable cache TTL (a year, `Cache-Control: immutable`) — since a content change always produces a *new* filename, there is never a staleness risk to invalidate away. Only the small, frequently-changing `index.html` entry point (which references those hashed filenames) needs a short TTL, or no caching at all, so that a fresh deploy is visible to users within seconds rather than however long a full `/*` invalidation takes to propagate globally. Under that pattern, deploys stop needing a `create-invalidation --paths "/*"` call at all — new hashed assets are simply new, uncached objects, and only `index.html`'s short TTL needs to naturally expire. AstriX's cache policy setup, per §3.4, doesn't differentiate TTLs by path today (every behavior shares the same `Managed-CachingOptimized` policy), so it hasn't adopted this pattern — but a full-invalidation-per-deploy approach is a completely defensible, simpler choice at this traffic scale, not a mistake; it only becomes worth the added complexity once invalidation latency or the (still-generous) free invalidation quota actually becomes a bottleneck.

---

## 8. Debug Drill

**Scenario: users report seeing an old version of the frontend after a deploy.**

Work through this in order, from most to least likely cause:

1. **Did the CloudFront invalidation actually run, and did it complete?** Check the `deploy-frontend.yml` run's "Invalidate CloudFront" step for a successful exit, then confirm in the AWS console or via `aws cloudfront get-invalidation` that the invalidation's status is `Completed`, not still `InProgress` — a full `/*` invalidation across all edge locations is not instantaneous, and a user hitting an edge that hasn't yet processed the invalidation will still see the old cached object for a short window.
2. **Is the browser itself serving a locally cached copy?** Browsers apply their own HTTP cache on top of whatever CloudFront returns; a hard refresh (bypassing the browser cache) or an incognito window rules this layer out before blaming the infrastructure.
3. **Did the S3 sync actually upload the new build?** Confirm the "Sync to S3" step ran against the correct bucket and actually completed — `aws s3 ls s3://<bucket> --recursive` and checking object `LastModified` timestamps confirms whether new objects landed at all, independent of whether CloudFront is serving them.
4. **Did the deploy pick up the right distribution ID?** The workflow discovers the distribution by matching the S3 bucket name against distribution origins at run time rather than hardcoding an ID — if a second distribution somehow matched that lookup, or the bucket name changed without updating the workflow's `S3_BUCKET` env var, the invalidation could have been issued against the wrong distribution entirely, leaving the real one serving stale cache indefinitely.

**Scenario: a deep-linked SPA route returns a CloudFront error page instead of the app.**

1. **Confirm which status code S3 is actually returning for that path.** An OAC-protected bucket typically returns 403 for a nonexistent key, not 404 — if `custom_error_response` were ever edited to map only 404 (dropping the 403 mapping), every unresolved SPA route would start returning CloudFront's raw error page again, since the actual status S3 sends would no longer have a matching `custom_error_response` block.
2. **Check whether the CloudFront Function is actually attached and deployed.** `enable_spa_routing` gates both the `function_association` block and the `aws_cloudfront_function` resource itself — if that variable were ever `false`, or if the function's `publish = true` state weren't actually live on the distribution's current default cache behavior, requests would fall through to relying on the `custom_error_response` fallback alone, which still works but takes the slower path (an actual S3 round trip and a 403/404 response before the rewrite happens) rather than the fast edge-side rewrite.
3. **Ask whether a new client-side route was added without confirming the SPA fallback still catches it.** The CloudFront Function's heuristic assumes "any URI containing a period is a static file, anything else is an app route." A newly added route that happens to include a literal `.` in its path segment (a version number, a decimal identifier passed as a URL param) would be misclassified by the function as a static-file request and passed through to S3 unmodified — at which point it depends entirely on the `custom_error_response` fallback catching the resulting 403/404, which it still does today, but it's worth knowing that the fast path and the fallback path don't have identical logic, so a change to route-naming conventions is worth testing against a hard refresh, not just client-side navigation (which never exercises either of these CDN-side mechanisms at all, since client-side navigation is JS calling `history.pushState`, not a new HTTP request).
