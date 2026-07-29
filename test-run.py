import subprocess
import os

tsc_bin = os.path.join(os.getcwd(), "node_modules", ".bin", "tsc")
try:
    r = subprocess.run([tsc_bin, "--noEmit"], capture_output=True, text=True)
    print("RC:", r.returncode)
    print("STDOUT:", r.stdout)
    print("STDERR:", r.stderr)
except Exception as e:
    print("EXCEPTION:", e)
