/* Trusted screenshot queue: no models, no TapNow submission and no publication. */
const {createHash}=require('node:crypto');
class PreparationQueue{
  constructor(request,capture){this.request=request;this.capture=capture;this.busy=false;this.attempted=new Set();}
  async tick(){
    if(this.busy)return;this.busy=true;
    try{
      const jobs=await this.request('jobs.list');
      for(const row of jobs.filter(j=>j.production_mode==='auto_prepare'&&j.state==='completed'&&!j.image_only)){
        let data=await this.request('jobs.get',{job_id:row.job_id});
        if(data.job.lease||data.article.spec.production_mode!=='auto_prepare')continue;
        const runs=Object.keys(data.runs);if(!runs.length)continue;
        let captured=false;
        for(const slot of data.slots.filter(s=>s.kind==='body_real'&&!s.selected_candidate)){
          if(slot.candidates?.some(c=>c.source==='run_capture'&&c.review_status==='rejected'))continue;
          // Use all real records, rather than guessing which output the caption describes.
          const fingerprint=createHash('sha256').update(JSON.stringify([row.job_id,slot.figure_no,data.runs])).digest('hex');
          if(this.attempted.has(fingerprint))continue;this.attempted.add(fingerprint);
          try{await this.capture(row.job_id,slot.figure_no,runs,true);captured=true;}
          catch(error){await this.request('automation.capture_failure',{job_id:row.job_id,figure_no:slot.figure_no,error:error.message}).catch(()=>{});}
        }
        if(captured)await this.request('articles.finalize',{job_id:row.job_id});
      }
    }finally{this.busy=false;}
  }
}
module.exports={PreparationQueue};
