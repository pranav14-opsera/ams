// Inlined as a TS string constant rather than a separate .hbs asset file
// — this repo has no nest-cli.json asset-copying configuration (verified
// directly), so a separate template file would silently not exist next
// to the compiled dist/ output. Handlebars.compile() works identically
// on an inline string.
export const THRESHOLD_BREACH_TEMPLATE_SOURCE = `
<!doctype html>
<html>
  <body style="font-family: sans-serif; color: #1f2937;">
    <h2>Agent Health Alert — {{severityLabel}}</h2>
    <table cellpadding="6" style="border-collapse: collapse;">
      <tr><td><strong>Agent</strong></td><td>{{agentName}}</td></tr>
      <tr><td><strong>Metric</strong></td><td>{{metricName}}</td></tr>
      <tr><td><strong>Threshold</strong></td><td>{{thresholdValue}}</td></tr>
      <tr><td><strong>Actual value</strong></td><td>{{actualValue}}</td></tr>
      <tr><td><strong>Severity</strong></td><td>{{severityLabel}}</td></tr>
      <tr><td><strong>Breach time</strong></td><td>{{breachTimestamp}}</td></tr>
    </table>
    <p><a href="{{detailUrl}}">View agent health detail</a></p>
  </body>
</html>
`;
