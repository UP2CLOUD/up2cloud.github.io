terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------

variable "cloudflare_api_token" {
  description = "Cloudflare API token with Permissions: Zone:DNS:Edit, Account:Cloudflare Pages:Edit"
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Cloudflare Zone ID for up2cloud.tech (Cloudflare dashboard → up2cloud.tech → Overview → Zone ID)"
}

# ---------------------------------------------------------------------------
# Locals
# ---------------------------------------------------------------------------

locals {
  account_id   = "6e6599da55818139812d41602175cffe"
  project_name = "up2cloud-tech"
  domain       = "up2cloud.tech"
}

# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# ---------------------------------------------------------------------------
# Cloudflare Pages — register custom domain
# This tells Cloudflare Pages to serve up2cloud.tech from the up2cloud-tech project.
# ---------------------------------------------------------------------------

resource "cloudflare_pages_domain" "apex" {
  account_id   = local.account_id
  project_name = local.project_name
  domain       = local.domain
}

resource "cloudflare_pages_domain" "www" {
  account_id   = local.account_id
  project_name = local.project_name
  domain       = "www.${local.domain}"
}

# ---------------------------------------------------------------------------
# DNS records
# Cloudflare CNAME flattening makes a CNAME work for the apex domain.
# proxied = true routes traffic through Cloudflare edge (DDoS, WAF, cache).
# ---------------------------------------------------------------------------

resource "cloudflare_record" "apex_cname" {
  zone_id = var.cloudflare_zone_id
  name    = "@"
  type    = "CNAME"
  value   = "${local.project_name}.pages.dev"
  proxied = true
  comment = "Cloudflare Pages — up2cloud.tech"

  depends_on = [cloudflare_pages_domain.apex]
}

resource "cloudflare_record" "www_cname" {
  zone_id = var.cloudflare_zone_id
  name    = "www"
  type    = "CNAME"
  value   = "${local.project_name}.pages.dev"
  proxied = true
  comment = "Cloudflare Pages — www.up2cloud.tech"

  depends_on = [cloudflare_pages_domain.www]
}
