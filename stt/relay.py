"""Forward the private gateway's stdin/stdout to the loopback GPU listener."""
import os
import select
import socket
import sys

with socket.create_connection(("127.0.0.1", 22105), timeout=5) as remote:
    remote.settimeout(None)
    inputs = [sys.stdin.buffer, remote]
    while inputs:
        ready, _, _ = select.select(inputs, [], [])
        for source in ready:
            if source is remote:
                data = remote.recv(65536)
                if not data:
                    sys.exit()
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            else:
                data = os.read(0, 65536)
                if data:
                    remote.sendall(data)
                else:
                    remote.shutdown(socket.SHUT_WR)
                    inputs.remove(source)
