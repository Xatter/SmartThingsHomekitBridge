#!/usr/bin/env python3
"""
Focused mDNS Test for HAP Server
Tests if the HAP server is properly advertising via mDNS/Bonjour
Exit 0 = success (discoverable)
Exit 1 = failure (not discoverable)
"""

import sys
import time
import subprocess
import socket

def test_mdns_with_avahi():
    """Test using avahi-browse if available (Linux)"""
    try:
        result = subprocess.run(
            ["avahi-browse", "-ptr", "_hap._tcp"],
            capture_output=True,
            text=True,
            timeout=5
        )
        if "SmartThings" in result.stdout:
            return True
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return False

def test_mdns_with_dns_sd():
    """Test using dns-sd (macOS)"""
    try:
        # Test 1: Browse for HAP services
        proc = subprocess.Popen(
            ["dns-sd", "-B", "_hap._tcp", "local."],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        time.sleep(3)
        proc.terminate()
        output, _ = proc.communicate(timeout=1)

        if "_hap._tcp" not in output:
            print(f"[FAIL] No HAP services found via mDNS", file=sys.stderr)
            return False

        print(f"[INFO] Found HAP services via mDNS", file=sys.stderr)

        # Test 2: Look up specific service (name changed to "SmartThings Bridge")
        proc = subprocess.Popen(
            ["dns-sd", "-L", "SmartThings Bridge", "_hap._tcp", "local."],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        time.sleep(3)
        proc.terminate()
        output, _ = proc.communicate(timeout=1)

        # Check for successful resolution
        if "can be reached at" in output:
            # Parse the port from output
            if ":51826" in output or "51826.local" in output:
                print(f"[SUCCESS] Bridge service properly advertised on port 51826", file=sys.stderr)
                return True

        # Alternative test: Query for the specific record
        proc = subprocess.Popen(
            ["dns-sd", "-q", "SmartThings HomeKit Bridge._hap._tcp.local", "SRV"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        time.sleep(2)
        proc.terminate()
        output, _ = proc.communicate(timeout=1)

        if "51826" in output:
            print(f"[SUCCESS] Bridge SRV record found", file=sys.stderr)
            return True

    except subprocess.TimeoutExpired:
        # Check the partial output
        if output and ("SmartThings" in output or "51826" in output):
            print(f"[SUCCESS] Bridge partially resolved", file=sys.stderr)
            return True
    except Exception as e:
        print(f"[ERROR] dns-sd test failed: {e}", file=sys.stderr)

    return False

def test_direct_port():
    """Test if HAP port is listening"""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(2)
        result = sock.connect_ex(("localhost", 51826))
        sock.close()
        if result == 0:
            print(f"[INFO] HAP port 51826 is listening", file=sys.stderr)
            return True
        else:
            print(f"[FAIL] HAP port 51826 is not accessible", file=sys.stderr)
            return False
    except Exception as e:
        print(f"[ERROR] Port test failed: {e}", file=sys.stderr)
        return False

def main():
    print("[INFO] Testing mDNS advertisement for HAP server...", file=sys.stderr)

    # First check if port is even listening
    if not test_direct_port():
        print("[FAIL] HAP server is not running on port 51826", file=sys.stderr)
        sys.exit(1)

    # Test mDNS
    if sys.platform == "darwin":
        success = test_mdns_with_dns_sd()
    else:
        success = test_mdns_with_avahi()

    if success:
        print("[SUCCESS] ✅ HAP server is properly advertised via mDNS", file=sys.stderr)
        sys.exit(0)
    else:
        print("[FAIL] ❌ HAP server is NOT properly advertised via mDNS", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()