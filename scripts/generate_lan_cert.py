"""Generate a self-signed cert covering localhost + the machine's LAN IP.

Written for the BRIDGE Spot dashboard: we serve HTTPS so getUserMedia is
allowed on the wifi URL, and pinning both localhost and the LAN address as
Subject Alternative Names means one cert covers every way this laptop is
reached (operator on the box, teammates on their phones).

Output goes to `<repo>/deployment/ssl/server.crt` and `server.key` in PEM
form, which is what uvicorn's ssl_keyfile/ssl_certfile expect.

The cert is valid for 5 years so nobody has to remember to renew it in the
middle of a demo; the private key never leaves this machine.
"""

import datetime
import ipaddress
import os
import socket
import sys

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def outbound_lan_ip() -> str:
    """The address a peer on the wifi would connect back to.

    We open a UDP socket to a public IP and read `getsockname()`, which is
    the OS's own routing decision without sending anything. `gethostname()`
    /`gethostbyname` on Windows often returns 127.0.0.1 or an APIPA
    address, depending on the hosts file.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        return probe.getsockname()[0]
    finally:
        probe.close()


def main() -> int:
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ssl_dir = os.path.join(repo_root, "deployment", "ssl")
    os.makedirs(ssl_dir, exist_ok=True)
    cert_path = os.path.join(ssl_dir, "server.crt")
    key_path = os.path.join(ssl_dir, "server.key")

    lan_ip = outbound_lan_ip()

    # SAN entries the browser checks. Include the LAN IP, localhost, both
    # loopbacks, and the machine name for good measure.
    san = [
        x509.DNSName("localhost"),
        x509.DNSName(socket.gethostname().lower()),
        x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
        x509.IPAddress(ipaddress.IPv4Address(lan_ip)),
    ]

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "Bridge Spot LAN"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "BRIDGE"),
    ])

    not_before = datetime.datetime.utcnow() - datetime.timedelta(days=1)
    not_after = not_before + datetime.timedelta(days=5 * 365)

    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(not_before)
        .not_valid_after(not_after)
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([x509.ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .sign(private_key=key, algorithm=hashes.SHA256())
    )

    with open(key_path, "wb") as fh:
        fh.write(
            key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )
    with open(cert_path, "wb") as fh:
        fh.write(cert.public_bytes(serialization.Encoding.PEM))

    print(f"lan_ip={lan_ip}")
    print(f"cert={cert_path}")
    print(f"key={key_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
