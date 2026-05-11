#!/usr/bin/env python3
"""
Simple seed URL ingestion script that bypasses the Node.js complexity
"""
import requests
import json
from pathlib import Path
import sys

# Fix encoding
sys.stdout.reconfigure(encoding='utf-8')

# Read seed URLs - handle BOM
seed_dir = Path("data/seed")
legalinfo_text = (seed_dir / "legalinfo_urls.txt").read_text(encoding='utf-8-sig')
shuukh_text = (seed_dir / "shuukh_urls.txt").read_text(encoding='utf-8-sig')

legalinfo_urls = [u.strip() for u in legalinfo_text.split('\n') if u.strip()]
shuukh_urls = [u.strip() for u in shuukh_text.split('\n') if u.strip()]

print(f"Found {len(legalinfo_urls)} legalinfo URLs")
print(f"Found {len(shuukh_urls)} shuukh URLs")

# Download legalinfo URLs to local files
print("\nDownloading legalinfo documents...")
output_dir = Path("data/raw/legalinfo_seed")
output_dir.mkdir(parents=True, exist_ok=True)

for i, url in enumerate(legalinfo_urls):
    print(f"[{i+1}/{len(legalinfo_urls)}] {url}")
    try:
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200:
            law_id = url.split('lawId=')[-1]
            output_file = output_dir / f"{law_id}.html"
            output_file.write_bytes(resp.content)
            print(f"  [OK] Saved {output_file}")
        else:
            print(f"  [FAIL] HTTP {resp.status_code}")
    except Exception as e:
        print(f"  [ERROR] {type(e).__name__}: {str(e)[:100]}")

# Download shuukh URLs to local files
print("\nDownloading shuukh documents...")
output_dir = Path("data/raw/shuukh_seed")
output_dir.mkdir(parents=True, exist_ok=True)

for i, url in enumerate(shuukh_urls):
    print(f"[{i+1}/{len(shuukh_urls)}] {url}")
    try:
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200:
            case_id = url.split('single_case/')[-1]
            output_file = output_dir / f"{case_id}.html"
            output_file.write_bytes(resp.content)
            print(f"  [OK] Saved {output_file}")
        else:
            print(f"  [FAIL] HTTP {resp.status_code}")
    except Exception as e:
        print(f"  [ERROR] {type(e).__name__}: {str(e)[:100]}")

print("\nDownloads complete! Now run:")
print("  pnpm --filter @legal-chatbot/worker ingest:seed-local")
