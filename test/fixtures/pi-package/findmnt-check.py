#!/usr/bin/env python3
"""Volume discovery double; never shipped or used on a real Pi."""
import json
import os
import sys
if not os.environ.get('LYTGUIDE_DISPOSABLE_CONTAINER'):
    sys.exit('Disposable package-check containers only.')
target = sys.argv[sys.argv.index('-T') + 1]
if target.startswith('/boot/firmware'):
    print(json.dumps({'filesystems': [{'target': '/boot/firmware', 'fstype': 'vfat'}]}))
else:
    sys.exit(1)
