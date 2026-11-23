#!/usr/bin/env python3
"""Offline test for scripts/ecr-login.py.

Disposable: a stub HTTP server on 127.0.0.1 plays the ECR endpoint and a
stub `docker` executable records what it receives on stdin. No network,
no AWS account, no Docker daemon. Run: python3 scripts/test-ecr-login.py
"""

import base64
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "ecr-login.py")
PASSWORD = "test-password-123"
TOKEN = base64.b64encode(f"AWS:{PASSWORD}".encode()).decode()

captured = {}


class StubEcr(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        captured["body"] = self.rfile.read(length)
        captured["authorization"] = self.headers.get("Authorization") or ""
        captured["target"] = self.headers.get("X-Amz-Target") or ""
        if captured.get("fail"):
            self.send_response(403)
            self.end_headers()
            self.wfile.write(b'{"message":"denied"}')
            return
        body = json.dumps(
            {"authorizationData": [{"authorizationToken": TOKEN}]}
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/x-amz-json-1.1")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def write_executable(path, content):
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)


def run_helper(tmp, endpoint, env_file):
    bin_dir = os.path.join(tmp, "bin")
    env = dict(os.environ)
    env["PATH"] = bin_dir + os.pathsep + env["PATH"]
    env["BP_ECR_ENDPOINT"] = endpoint
    env["BP_ECR_PULL_ENV"] = env_file
    return subprocess.run(
        [sys.executable, HELPER, "123456789012.dkr.ecr.us-east-1.amazonaws.com"],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )


def main():
    tmp = tempfile.mkdtemp(prefix="ecr-login-test-")
    bin_dir = os.path.join(tmp, "bin")
    os.makedirs(bin_dir)
    stdin_file = os.path.join(tmp, "docker-stdin")
    marker_file = os.path.join(tmp, "docker-invoked")
    write_executable(
        os.path.join(bin_dir, "docker"),
        "#!/bin/sh\n"
        f'cat > "{stdin_file}"\n'
        f'touch "{marker_file}"\n'
        "exit 0\n",
    )
    env_file = os.path.join(tmp, "pull.env")
    with open(env_file, "w", encoding="utf-8") as handle:
        handle.write(
            "AWS_ACCESS_KEY_ID=AKIDEXAMPLE\n"
            "AWS_SECRET_ACCESS_KEY=testsecretkey\n"
        )

    server = HTTPServer(("127.0.0.1", 0), StubEcr)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    endpoint = f"http://127.0.0.1:{server.server_address[1]}/"
    try:
        result = run_helper(tmp, endpoint, env_file)
        assert result.returncode == 0, f"helper failed: {result.stdout} {result.stderr}"
        assert captured["target"] == (
            "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken"
        ), f"wrong X-Amz-Target: {captured['target']}"
        auth = captured["authorization"]
        assert auth.startswith(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/"
        ), f"bad Authorization header: {auth}"
        assert "SignedHeaders=" in auth and "x-amz-target" in auth, auth
        assert os.path.isfile(marker_file), "docker login was not invoked"
        with open(stdin_file, encoding="utf-8") as handle:
            assert handle.read() == PASSWORD, "docker did not receive the ECR password on stdin"
        assert PASSWORD not in result.stdout, "password leaked to stdout"
        assert TOKEN not in result.stdout, "token leaked to stdout"
        print("PASS: signed GetAuthorizationToken request; password piped to docker login only")

        captured["fail"] = True
        os.remove(marker_file)
        result = run_helper(tmp, endpoint, env_file)
        assert result.returncode != 0, "helper should fail when ECR denies the request"
        assert not os.path.isfile(marker_file), "docker must not be invoked after an ECR failure"
        print("PASS: ECR denial fails the helper before docker is invoked")
    finally:
        server.shutdown()
    print("All ecr-login tests passed.")


if __name__ == "__main__":
    main()
