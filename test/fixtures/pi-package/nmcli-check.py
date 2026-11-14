#!/usr/bin/env python3
"""NetworkManager double for a disposable internal-network test container only."""
import os,sys
if not os.environ.get('LYTGUIDE_DISPOSABLE_CONTAINER'):sys.exit('Disposable check only')
a=sys.argv[1:]
if a==['--version']:print('nmcli tool, version 1.52.1')
elif 'device' in a and 'status' in a:print('eth0:ethernet:connected:warehouse-router')
elif 'wifi' in a and 'list' in a:pass
else:sys.exit('Unexpected nmcli operation: '+repr(a))
