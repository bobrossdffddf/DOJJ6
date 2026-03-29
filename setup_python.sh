#!/bin/bash
# Run this once on your server to set up the Python environment for PDF generation.
# Works on Debian 12/13 and any system with PEP 668 pip restrictions.

set -e

echo "[setup] Creating Python virtual environment in .venv/ ..."
python3 -m venv .venv

echo "[setup] Installing required packages (pypdf, reportlab) ..."
.venv/bin/pip install --upgrade pip --quiet
.venv/bin/pip install pypdf reportlab --quiet

echo "[setup] Done. Python environment is ready."
echo "[setup] You can now start the server with: npm start"
