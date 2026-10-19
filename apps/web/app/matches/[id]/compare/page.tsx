import Comparison from "./view";
export default async function Page({ params, searchParams }: { params: Promise<{id:string}>; searchParams: Promise<{accountId?:string;datasetId?:string}> }) {
  const {id}=await params, q=await searchParams;
  return <Comparison key={`${id}:${q.datasetId}:${q.accountId}`} matchId={id} datasetId={typeof q.datasetId==='string'?q.datasetId:''} accountId={typeof q.accountId==='string'?q.accountId:''}/>;
}
