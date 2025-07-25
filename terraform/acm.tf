module "acm_certificate" {
  source  = "cloudposse/acm-request-certificate/aws"
  version = "0.18.0"

  domain_name                       = aws_route53_zone.this.name
  zone_id                           = aws_route53_zone.this.id
  process_domain_validation_options = true
  ttl                               = "300"
  subject_alternative_names         = [join(".", ["*", aws_route53_zone.this.name])]
}

import {
  to = module.acm_certificate.aws_acm_certificate.default[0]
  id = data.aws_acm_certificate.this.arn
}
