export function coachReportLink(matchId:string,datasetId:string,analysisId:string,accountId:string,reportId:string) {
  return `/matches/${encodeURIComponent(matchId)}/coach?${new URLSearchParams({datasetId,analysisId,accountId,reportId})}`;
}
