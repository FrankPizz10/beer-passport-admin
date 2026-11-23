#!/usr/bin/env python3
"""ecr-login.py - refresh the Lightsail host's Amazon ECR authentication.

Runs ON the Lightsail instance (installed at /opt/beerpassport-admin/,
root-owned) immediately before an ECR pull, invoked by deploy-api.sh.
The host has no AWS CLI, so this script performs the ECR
GetAuthorizationToken call directly: an AWS Signature Version 4 signed
HTTPS request built only from the Python 3 standard library.

Credential sources, in order (first one found wins):
  1. The pull-only env file named by BP_ECR_PULL_ENV (default
     /etc/beerpassport/secrets/aws-ecr-pull.env), used by the FALLBACK
     pull-only IAM user. Root-only, mode 0600. Expected keys:
     AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, optional AWS_SESSION_TOKEN.
  2. The SSM Agent's shared credentials file (~/.aws/credentials,
     profile "default"), used by the PRIMARY design: the host's managed
     node IAM role extended with the pull-only policy. Those credentials
     are temporary and are refreshed by the SSM Agent itself.

Either way there are no long-lived credentials in Git or in logs, and
the ECR password (valid 12 hours) is never printed: it is piped to
`docker login --password-stdin`. deploy-api.sh points DOCKER_CONFIG at
a temporary directory for the login and the pull and deletes it
afterwards, so no registry credential persists on disk.

Usage: ecr-login.py <registry-host>
  e.g. ecr-login.py 149290600858.dkr.ecr.us-east-1.amazonaws.com

Environment overrides: BP_ECR_REGION (default us-east-1),
BP_ECR_ENDPOINT (default https://ecr.<region>.amazonaws.com/; used by
the offline test in scripts/test-ecr-login.py).
"""

import base64
import configparser
import datetime
import hashlib
import hmac
import json
import os
import subprocess
import sys
import urllib.request

SERVICE = "ecr"
TARGET = "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken"
ALGORITHM = "AWS4-HMAC-SHA256"


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    return 1


def load_credentials():
    """Return (access_key, secret_key, session_token_or_None, source)."""
    env_path = os.environ.get(
        "BP_ECR_PULL_ENV", "/etc/beerpassport/secrets/aws-ecr-pull.env"
    )
    if os.path.isfile(env_path):
        values = {}
        with open(env_path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip('"').strip("'")
        access = values.get("AWS_ACCESS_KEY_ID")
        secret = values.get("AWS_SECRET_ACCESS_KEY")
        if access and secret:
            return access, secret, values.get("AWS_SESSION_TOKEN") or None, env_path
    agent_file = os.path.expanduser("~/.aws/credentials")
    if os.path.isfile(agent_file):
        parser = configparser.ConfigParser()
        parser.read(agent_file)
        if parser.has_section("default"):
            section = parser["default"]
            access = section.get("aws_access_key_id")
            secret = section.get("aws_secret_access_key")
            if access and secret:
                return (
                    access,
                    secret,
                    section.get("aws_session_token") or None,
                    agent_file,
                )
    return None, None, None, None


def sign(key, message):
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def signature_key(secret, date_stamp, region):
    k_date = sign(("AWS4" + secret).encode("utf-8"), date_stamp)
    k_region = hmac.new(k_date, region.encode("utf-8"), hashlib.sha256).digest()
    k_service = hmac.new(k_region, SERVICE.encode("utf-8"), hashlib.sha256).digest()
    return hmac.new(k_service, b"aws4_request", hashlib.sha256).digest()


def get_authorization_token(access, secret, token, region, endpoint):
    body = b"{}"
    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    host = endpoint.split("://", 1)[1].rstrip("/")

    headers = {
        "content-type": "application/x-amz-json-1.1",
        "host": host,
        "x-amz-date": amz_date,
        "x-amz-target": TARGET,
    }
    if token:
        headers["x-amz-security-token"] = token
    signed_names = sorted(headers)
    canonical_headers = "".join(f"{name}:{headers[name]}\n" for name in signed_names)
    signed_headers = ";".join(signed_names)
    payload_hash = hashlib.sha256(body).hexdigest()
    canonical_request = "\n".join(
        ["POST", "/", "", canonical_headers, signed_headers, payload_hash]
    )
    scope = f"{date_stamp}/{region}/{SERVICE}/aws4_request"
    string_to_sign = "\n".join(
        [
            ALGORITHM,
            amz_date,
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    signature = hmac.new(
        signature_key(secret, date_stamp, region),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    authorization = (
        f"{ALGORITHM} Credential={access}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    request_headers = {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Date": amz_date,
        "X-Amz-Target": TARGET,
        "Authorization": authorization,
    }
    if token:
        request_headers["X-Amz-Security-Token"] = token
    request = urllib.request.Request(
        endpoint, data=body, headers=request_headers, method="POST"
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    entries = payload.get("authorizationData") or []
    if not entries or not entries[0].get("authorizationToken"):
        raise RuntimeError("ECR returned no authorization token")
    decoded = base64.b64decode(entries[0]["authorizationToken"]).decode("utf-8")
    _, _, password = decoded.partition(":")
    if not password:
        raise RuntimeError("ECR authorization token had an unexpected shape")
    return password


def main(argv):
    if len(argv) != 2:
        print(f"Usage: {argv[0]} <registry-host>", file=sys.stderr)
        return 64
    registry = argv[1]
    region = os.environ.get("BP_ECR_REGION", "us-east-1")
    endpoint = os.environ.get(
        "BP_ECR_ENDPOINT", f"https://ecr.{region}.amazonaws.com/"
    )
    access, secret, token, source = load_credentials()
    if not access:
        return fail(
            "no AWS credentials found for the ECR pull identity "
            "(checked the pull env file and the SSM agent credentials file)"
        )
    try:
        password = get_authorization_token(access, secret, token, region, endpoint)
    except Exception as exc:  # network, HTTP, or payload problem
        return fail(f"ECR GetAuthorizationToken failed: {exc}")
    result = subprocess.run(
        ["docker", "login", "--username", "AWS", "--password-stdin", registry],
        input=password.encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        return fail("docker login to ECR failed")
    print(f"ECR authentication refreshed for {registry} (credentials: {source}).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
