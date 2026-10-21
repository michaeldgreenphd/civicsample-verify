import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const password='e2e-only-generated-fictional-passphrase';
const origin='http://127.0.0.1:3100';
async function signIn(page: Page, account: string) {
  await page.goto('/');
  await page.getByLabel('Pilot account').selectOption(account);
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('button',{name:'Sign out'})).toBeVisible();
}
async function post(context: BrowserContext,path: string,data: unknown) { return context.request.post(path,{data,headers:{origin}}); }
const answer=(decision='INCLUDE') => ({decision,rationale:'Fictional engineering judgment. This is not clinical evidence.',uncertain:false,context:'',packetProblem:false});
const hidden = /tier0_binary|tier1_binary|prediction_set|selection_probability|comparison_cell|frame_unit|request\.jwt|service_role|snapshot_hash/;

test('four isolated browser roles: review, two-step blinding, adjudication, lock and export',async ({browser}) => {
  const contexts = await Promise.all(Array.from({length:4},()=>browser.newContext({baseURL:origin})));
  const [admin,a,b,adj] = contexts; const pages=await Promise.all(contexts.map(c=>c.newPage()));
  const [adminPage,aPage,bPage,adjPage]=pages;
  await signIn(adminPage,'investigator');
  await expect(adminPage.getByRole('heading',{name:'Pilot overview'})).toBeVisible();
  await expect(adminPage.getByRole('heading',{name:'Readiness gates'})).toBeVisible();
  await adminPage.screenshot({path:'test-results/investigator-desktop.png',fullPage:true});
  for (const [page,account] of [[aPage,'reviewer-a'],[bPage,'reviewer-b'],[adjPage,'adjudicator']] as const) await signIn(page,account);
  expect((await adj.request.get('/api/cases/SYN-001')).status()).toBeGreaterThanOrEqual(400);
  expect((await a.request.get('/api/admin/export')).status()).toBe(403);
  expect((await a.request.get('/api/audit')).status()).toBe(404);
  expect((await a.request.get('/api/cases/SYN-999')).status()).toBe(404);
  expect((await post(a,'/api/admin/action',{action:'close',attestation:'test'})).status()).toBe(403);
  expect((await post(admin,'/api/admin/action',{action:'activate-formal',attestation:'test'})).status()).toBe(403);
  expect((await a.request.post('/api/cases/SYN-001/submit',{data:answer(),headers:{origin:'https://untrusted.example'}})).status()).toBe(403);
  const beforeTrial=await (await a.request.get('/api/cases/SYN-009')).json();
  expect(beforeTrial.trialPacket).toBeUndefined(); expect(JSON.stringify(beforeTrial)).not.toMatch(/Fictional trial|SYN-NCT/);
  expect(JSON.stringify(beforeTrial)).not.toMatch(hidden);
  expect((await post(a,'/api/cases/SYN-009/submit',answer())).status()).toBe(409);
  expect((await post(a,'/api/cases/SYN-001/submit',{...answer('CONTEXT_DEPENDENT'),context:'x'})).status()).toBe(400);
  expect((await post(a,'/api/cases/SYN-001/submit',{...answer(),reviewerId:'another-user'})).status()).toBe(400);

  await expect(aPage.getByRole('heading',{name:'Your review workspace'})).toBeVisible();
  await aPage.getByRole('radio',{name:/^Include\b/}).check();
  await aPage.getByLabel(/^Rationale/).fill('Reviewer A private rationale: fictional engineering response.');
  await expect(aPage.getByText(/saved/i).first()).toBeVisible();
  const bFirst=await (await b.request.get('/api/cases/SYN-001')).text();
  expect(bFirst).not.toContain('Reviewer A private');
  expect(await (await admin.request.get('/api/workspace')).text()).not.toContain('Reviewer A private');
  await aPage.screenshot({path:'test-results/reviewer-desktop.png',fullPage:true});
  const axe=await new AxeBuilder({page:aPage}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  expect(axe.violations).toEqual([]);
  await aPage.getByRole('button',{name:'Submit judgment',exact:true}).click();
  await aPage.getByRole('button',{name:/Confirm &/}).click();
  await expect(aPage.getByText(/Final submission locked/i).first()).toBeVisible();
  expect((await post(a,'/api/cases/SYN-001/submit',answer('EXCLUDE'))).status()).toBe(409);

  for (const [context,slot] of [[a,'A'],[b,'B']] as const) {
    for (let i=1;i<=10;i++) {
      if (slot==='A' && i===1) continue;
      const id=`SYN-${String(i).padStart(3,'0')}`;
      if(i>=9) {
        const step=await post(context,`/api/cases/${id}/step1`,answer()); expect(step.ok(),await step.text()).toBeTruthy();
        const detail=await (await context.request.get(`/api/cases/${id}`)).json(); expect(detail.trialPacket.registryId).toMatch(/^SYN-NCT/);
      }
      const result=await post(context,`/api/cases/${id}/submit`,{...answer(slot==='B' && i===1?'EXCLUDE':'INCLUDE'),...(i>=9?{descriptorRole:'DISEASE_STUDIED'}:{})});
      expect(result.ok(),await result.text()).toBeTruthy();
      const reviewerBody=await (await context.request.get(`/api/cases/${id}`)).text(); expect(reviewerBody).not.toMatch(hidden);
    }
  }
  await adminPage.reload();
  await adminPage.getByRole('button',{name:'Close independent review'}).click();
  await adminPage.getByLabel('Attestation / reason').fill('Synthetic investigator closes the completed pilot.');
  await adminPage.getByRole('button',{name:'Confirm action'}).click();
  await expect(adminPage.getByRole('button',{name:'Authorize adjudication'})).toBeEnabled();
  expect((await post(a,'/api/cases/SYN-002/draft',answer())).status()).toBe(409);
  await adminPage.getByRole('button',{name:'Authorize adjudication'}).click();
  await adminPage.getByLabel('Attestation / reason').fill('Authorize separate synthetic adjudication.');
  await adminPage.getByRole('button',{name:'Confirm action'}).click();
  await expect(adminPage.getByRole('button',{name:'Lock pilot & enable export'})).toBeEnabled();
  await adjPage.reload();
  await adjPage.getByLabel('Judgment level').selectOption('DESCRIPTOR_LEVEL');
  await expect(adjPage.getByText('Reviewer A private rationale: fictional engineering response.')).toBeVisible();
  await adjPage.getByRole('radio',{name:/^Include\b/}).check();
  await adjPage.getByLabel(/^Rationale/).fill('Synthetic adjudicator resolution.');
  await adjPage.getByLabel(/^Basis for/).fill('Comparison of the fictional packet and independent responses.');
  await adjPage.getByLabel(/^Reason code/).selectOption('CONSTRUCT_BOUNDARY');
  await adjPage.getByRole('button',{name:/Review & submit adjudication/}).click();
  await adjPage.getByRole('button',{name:'Confirm & lock'}).click();
  await expect(adjPage.getByText('Adjudication locked',{exact:true})).toBeVisible();
  await adjPage.screenshot({path:'test-results/adjudicator-desktop.png',fullPage:true});
  for(let i=1;i<=10;i++) {
    const id=`SYN-${String(i).padStart(3,'0')}`;
    const detail=await (await adj.request.get(`/api/cases/${id}`)).json();
    expect(JSON.stringify(detail)).not.toMatch(hidden);
    const levels=[...new Set<string>(detail.humanReviews.map((r:{level:string})=>r.level))];
    for(const level of levels) {
      if(i===1) continue;
      const result=await post(adj,`/api/cases/${id}/adjudicate`,{...answer(),level,status:'RESOLVED',basis:'Fictional packet',reasonCode:'OTHER'});
      expect(result.ok(),await result.text()).toBeTruthy();
    }
  }
  await adminPage.getByRole('button',{name:'Lock pilot & enable export'}).click();
  await adminPage.getByLabel('Attestation / reason').fill('Lock the synthetic pilot reference.');
  await adminPage.getByRole('button',{name:'Confirm action'}).click();
  await expect(adminPage.getByRole('link',{name:/Download locked export/})).toBeVisible();
  const exported=await admin.request.get('/api/admin/export'); expect(exported.ok(),await exported.text()).toBeTruthy();
  const bundle=await exported.json(); expect(bundle.manifest.analysis_eligible).toBe(false); expect(bundle.manifest.clinical_metrics).toBeNull();
  expect(bundle.files.find((f:{role:string})=>f.role==='independent_judgments').rows).toBe(24);
  expect((await adj.request.get('/api/admin/export')).status()).toBe(403);
  await aPage.setViewportSize({width:390,height:844}); await aPage.reload();
  await expect(aPage.getByText('Final submission locked',{exact:true})).toBeVisible();
  await aPage.keyboard.press('Tab');
  expect(await aPage.evaluate(()=>document.activeElement?.tagName)).not.toBe('BODY');
  expect(await aPage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await aPage.screenshot({path:'test-results/reviewer-mobile.png',fullPage:true});
  for(const context of contexts) await context.close();
});
