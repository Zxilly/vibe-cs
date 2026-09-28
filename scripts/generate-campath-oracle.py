"""Generate Rust test goldens using the pinned, unmodified HLAE math routines.

Usage: python scripts/generate-campath-oracle.py HLAE_SOURCE OUTPUT_JSON
Requires g++ on PATH. Upstream code is compiled in a temporary directory and is
not copied into Vibe CS. Source must be the reviewed v2.191.1 checkout.
"""
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile

REVISION = "b97636852b8eecae09285b5a386192bb285638eb"
source, output = map(Path, sys.argv[1:])
revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
if revision != REVISION:
    raise SystemExit(f"Expected HLAE {REVISION}, received {revision}")
subprocess.run(["git", "-C", str(source), "diff", "--exit-code", REVISION,
                "--", "shared/AfxMath.cpp", "shared/AfxMath.h"], check=True)

cases = [
    ("uneven-wrap", 64.0, [0, 43, 157, 256], [[-1000, 20, 64, -15, 179, 8, 72], [-980, 65, 80, 20, -176, -12, 88], [-880, -20, 192, -42, -120, 35, 110], [-750, 10, 92, 15, -80, 0, 82]]),
    ("stationary", 64.0, [0, 64, 128, 192], [[12, -4, 128, 5, 22, -3, 90]] * 4),
    ("near-pole", 128.0, [0, 16, 112, 384, 512, 640], [[0, 0, 0, 85, -40, 10, 100], [3, 6, 10, 89.999, 50, -8, 72], [60, -20, 160, 92, 140, 18, 85], [100, 50, 300, -89, -130, 40, 110], [120, 80, 100, -80, -20, 25, 78], [130, 20, 60, 0, 20, 0, 90]]),
    ("decimal-time", 60.0, [0, 1, 47, 113], [[1.12345678, 2, 3, 0.12345678, -0.0000002, 0, 90.0000004], [4, -2, 10, 0.1234568, 0, 0, 90], [30, 100, 50, 55, 110, 0, 65], [50, 120, 20, -15, 150, 0, 80]]),
]

goldens = []
with tempfile.TemporaryDirectory(prefix="vibe-campath-oracle-") as temporary:
    root = Path(temporary)
    # Drop only the PCH include; algorithm source and constants stay untouched.
    original = (source / "shared/AfxMath.cpp").read_text(encoding="utf-8-sig")
    (root / "AfxMath.cpp").write_text(original.replace('#include "stdafx.h"', '#include <cstddef>\n#include <algorithm>'), encoding="utf-8")
    (root / "AfxMath.h").write_bytes((source / "shared/AfxMath.h").read_bytes())
    (root / "oracle.cpp").write_text(r'''
#include <cstddef>
#include <iostream>
#include <iomanip>
#include <vector>
#include <array>
#include <cmath>
#include "AfxMath.h"
using namespace Afx::Math;
int main() {
  int n, count, positionLinear, rotationLinear;
  std::cin >> n >> count >> positionLinear >> rotationLinear;
  std::vector<double> t(n), x(n), y(n), z(n), f(n), x2(n), y2(n), z2(n), f2(n);
  auto q = new double[n][4]; auto w = new double[n][3]; auto e = new double[n-1][3];
  std::vector<double> h(n-1), angles(n-1);
  for(int i=0;i<n;i++) {
    double pitch,yaw,roll;
    std::cin >> t[i] >> x[i] >> y[i] >> z[i] >> pitch >> yaw >> roll >> f[i];
    auto value=Quaternion::FromQREulerAngles(QREulerAngles::FromQEulerAngles(QEulerAngles(pitch,yaw,roll)));
    q[i][0]=value.X;q[i][1]=value.Y;q[i][2]=value.Z;q[i][3]=value.W;
    if(i>0) { double dot=0;for(int j=0;j<4;j++)dot+=q[i][j]*q[i-1][j];if(dot<0)for(int j=0;j<4;j++)q[i][j]*=-1; }
  }
  spline(t.data(),x.data(),n,false,0,false,0,x2.data());
  spline(t.data(),y.data(),n,false,0,false,0,y2.data());
  spline(t.data(),z.data(),n,false,0,false,0,z2.data());
  spline(t.data(),f.data(),n,false,0,false,0,f2.data());
  double zero[3]={0,0,0};qspline_init(n,2,AFX_MATH_EPS,zero,zero,t.data(),q,h.data(),angles.data(),e,w);
  std::cout << std::setprecision(17);
  for(int k=0;k<count;k++) {
    double time;std::cin >> time;time=std::min(t.back(),std::max(t.front(),time));
    int left=0;while(left<n-2 && t[left+1]<=time)left++;
    double amount=(time-t[left])/(t[left+1]-t[left]);
    double px,py,pz,pf,r[4],omega[3],alpha[3];
    splint(t.data(),x.data(),x2.data(),n,time,&px);splint(t.data(),y.data(),y2.data(),n,time,&py);
    splint(t.data(),z.data(),z2.data(),n,time,&pz);splint(t.data(),f.data(),f2.data(),n,time,&pf);
    if(positionLinear){px=x[left]*(1-amount)+x[left+1]*amount;py=y[left]*(1-amount)+y[left+1]*amount;pz=z[left]*(1-amount)+z[left+1]*amount;}
    qspline_interp(n,time,t.data(),q,h.data(),angles.data(),e,w,r,omega,alpha);
    if(rotationLinear){auto value=Quaternion(q[left][3],q[left][0],q[left][1],q[left][2]).Slerp(Quaternion(q[left+1][3],q[left+1][0],q[left+1][1],q[left+1][2]),amount);r[0]=value.X;r[1]=value.Y;r[2]=value.Z;r[3]=value.W;}
    std::cout<<px<<' '<<py<<' '<<pz<<' '<<r[0]<<' '<<r[1]<<' '<<r[2]<<' '<<r[3]<<' '<<pf<<'\n';
  }
  delete[] q;delete[] w;delete[] e;
}
''', encoding="utf-8")
    executable = root / "oracle.exe"
    subprocess.run(["g++", "-std=c++17", "-O2", "-Dabstract=", "-include", "cstddef", str(root / "oracle.cpp"), str(root / "AfxMath.cpp"), "-o", str(executable)], check=True)
    for name, tick_rate, ticks, values in cases:
        for linear in (False, True):
            duration = ticks[-1] / tick_rate
            count = math.ceil(duration * 30) + 1
            times = [min(i / 30, duration) for i in range(count)]
            rows = [f"{len(ticks)} {count} {int(linear)} {int(linear)}"]
            rows += [" ".join(f"{v:.6f}" for v in [tick / tick_rate, *value]) for tick, value in zip(ticks, values)]
            rows += [repr(time) for time in times]
            result = subprocess.check_output([str(executable)], input="\n".join(rows), text=True)
            samples = [[float(value) for value in row.split()] for row in result.splitlines()]
            goldens.append({"name": name + ("-linear" if linear else "-cubic"), "tick_rate": tick_rate, "ticks": ticks, "keys": values, "linear": linear, "samples": samples})
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps({"upstream": REVISION, "cases": goldens}, separators=(",", ":")) + "\n", encoding="utf-8")
print(f"Wrote {len(goldens)} cases to {output}")
