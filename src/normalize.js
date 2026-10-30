const severityMap = { error: 'error', err: 'error', fatal: 'critical', critical: 'critical', warn: 'warning', warning: 'warning', info: 'info', debug: 'info' };

export function parseLogLines(rawLogs, maxLines = 500) {
  const lines = String(rawLogs ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, maxLines);
  return lines.map((line, index) => {
    const iso = line.match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\]/);
    const clock = line.match(/\b(\d{2}:\d{2}:\d{2})\b/);
    const levelMatch = line.match(/\b(ERROR|ERR|FATAL|CRITICAL|WARN|WARNING|INFO|DEBUG)\b/i);
    const serviceMatch = line.match(/\b(?:service|svc|app|component)=([\w.-]+)/i);
    const withoutTimestamp = line.replace(/^\[[^\]]+\]\s*/, '');
    const afterLevel = levelMatch ? withoutTimestamp.replace(new RegExp(`^${levelMatch[1]}\\s+`, 'i'), '') : withoutTimestamp;
    const serviceToken = afterLevel.match(/^([a-zA-Z][\w.-]*)\b/);
    const level = severityMap[(levelMatch?.[1] ?? 'info').toLowerCase()] ?? 'info';
    return {
      id: `U${String(index + 1).padStart(3, '0')}`,
      time: iso?.[1] ?? clock?.[1] ?? `line ${index + 1}`,
      service: serviceMatch?.[1] ?? serviceToken?.[1] ?? 'unknown-service',
      level,
      message: withoutTimestamp.slice(0, 1000),
      source: 'uploaded-log'
    };
  });
}

export function buildEvidence(scenario, rawLogs) {
  const isOverride = typeof rawLogs === 'string' && rawLogs.trim().length > 0 && rawLogs.trim() !== scenario.rawLogs.trim();
  if (!isOverride) return scenario.events.map((event) => ({ ...event }));
  const parsed = parseLogLines(rawLogs);
  return parsed.length ? parsed : scenario.events.map((event) => ({ ...event }));
}

export function summarizeLogSignals(events) {
  const counts = { error: 0, warning: 0, info: 0, critical: 0 };
  for (const event of events) counts[event.level] = (counts[event.level] ?? 0) + 1;
  return { eventCount: events.length, ...counts };
}

export function isValidEvidenceReference(id, evidence) {
  return evidence.some((event) => event.id === id);
}
