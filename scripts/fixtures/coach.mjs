import { saveDataset, transaction } from '@dota/persistence';
import { analysisHandler, defaultVersions, buildCoachInput } from '@dota/jobs';
import { fixture, death, objective } from './analysis.mjs';
export async function coachFixture(pool, settings={role:null,goal:'overview'}, events=[death('death-1',100),objective('tower-1',130)]) {
  const ctx=fixture(events);
  await saveDataset(pool,{id:'dataset',matchId:'1',parserRunId:null,normalizationVersion:'fixture',inputSha256:'a'.repeat(64),versions:{}},ctx.records);
  await pool.query('INSERT INTO dota.dataset_checks(dataset_id,version,payload) VALUES ($1,$2,$3)',['dataset',ctx.validation.version,ctx.validation]);
  const analysis=await analysisHandler(pool)({row:{dataset_id:'dataset',account_id:'1',analysis_options:null,versions:await defaultVersions()},signal:new AbortController().signal,steps:{}});
  await transaction(pool,analysis.commit);
  return buildCoachInput(pool,'dataset','1',analysis.analysisId,settings);
}
export function validCoachOutput(input) {
  const c=input.context, episodes=c.episodes.slice(0,3).map(e=>({episodeId:e.id,factIds:e.factIds,hypothesis:'Возможно, перед эпизодом стоило проверить возможность союзников продолжить действие.',question:'Какая информация была доступна игроку перед решением?'}));
  return {summaryFactIds:c.facts.filter(f=>f.episodeId===null).map(f=>f.id),episodes,
    nextAction:{kind:episodes.length?'review':'experiment',episodeId:episodes[0]?.episodeId??null,text:episodes.length?'Проверь выбранный эпизод и запиши доступную альтернативу.':'Как эксперимент, записывай причины выбранных действий и проверяй их после игры.'}};
}
