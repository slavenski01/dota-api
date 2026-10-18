import Link from 'next/link';
import MatchCoach from '../coach';
export default async function CoachPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const {id}=await params,q=await searchParams;
  const single=(key:string)=>typeof q[key]==='string'?q[key] as string:'';
  return <main><Link href={`/matches/${encodeURIComponent(id)}?${new URLSearchParams({accountId:single('accountId')})}`}>← К матчу</Link><h1>Разбор матча</h1>
    {['datasetId','analysisId','accountId','reportId'].every(key=>single(key))?<MatchCoach key={`${id}:${single('datasetId')}:${single('analysisId')}:${single('accountId')}`} matchId={id} datasetId={single('datasetId')} analysisId={single('analysisId')} accountId={single('accountId')} pinned/>:<p role="alert">В ссылке не указаны данные или версия отчёта. Откройте разбор из карточки матча.</p>}
  </main>;
}
