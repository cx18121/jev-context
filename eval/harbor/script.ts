/** Fixed smoke solution, not a model and never part of a quality evaluation. */
export function smokeCommand(mode: 'correct' | 'wrong'): string {
  if (mode === 'wrong') return "printf 'period,severity,count\\n' > summary.csv";
  return `python3 - <<'PY'
import csv, re
from collections import Counter
from datetime import date, timedelta
from pathlib import Path
reference = date(2025, 8, 12)
counts = {period: Counter() for period in ['today', 'last_7_days', 'last_30_days', 'month_to_date', 'total']}
for path in Path('logs').glob('*.log'):
    day = date.fromisoformat(path.name[:10])
    frequencies = Counter(re.findall(r'\\[(ERROR|WARNING|INFO)\\]', path.read_text()))
    counts['total'].update(frequencies)
    for period, start in [('today', reference), ('last_7_days', reference - timedelta(days=6)), ('last_30_days', reference - timedelta(days=29)), ('month_to_date', reference.replace(day=1))]:
        if start <= day <= reference:
            counts[period].update(frequencies)
with open('summary.csv', 'w', newline='') as output:
    writer = csv.writer(output)
    writer.writerow(['period', 'severity', 'count'])
    for period, values in counts.items():
        for severity in ['ERROR', 'WARNING', 'INFO']:
            writer.writerow([period, severity, values[severity]])
print('Wrote summary.csv from log contents')
PY`;
}
