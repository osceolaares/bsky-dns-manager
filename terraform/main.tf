resource "aws_amplify_app" "website" {
  name       = var.domain_name
  repository = var.repository

  platform     = "WEB"
  access_token = var.gh_access_token

  environment_variables = {
    REACT_APP_GOOGLE_CLIENT_ID = var.google_client_id
    REACT_APP_DNS_API_URL      = "https://${aws_api_gateway_rest_api.dns_manager_api.id}.execute-api.${data.aws_region.current.region}.amazonaws.com/prod/api/dns"
  }

  custom_rule {
    source = "/<*>"
    status = "404"
    target = "/404.html"
  }
}

resource "aws_amplify_branch" "main" {
  app_id                      = aws_amplify_app.website.id
  branch_name                 = "main"
  stage                       = "PRODUCTION"
  enable_pull_request_preview = true
  framework                   = "Web"
}

resource "aws_amplify_domain_association" "website" {
  app_id                 = aws_amplify_app.website.id
  domain_name            = var.domain_name
  enable_auto_sub_domain = true

  certificate_settings {
    custom_certificate_arn = module.acm_certificate.arn
    type                   = "CUSTOM"
  }

  sub_domain {
    branch_name = aws_amplify_branch.main.branch_name
    prefix      = ""
  }

  lifecycle {
    ignore_changes = [sub_domain]
  }
}
