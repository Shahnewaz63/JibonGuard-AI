export function rebuildUsageRollups(db,{now=Math.floor(Date.now()/1000),daysBack=400}={}){
  const start=new Date((now-daysBack*86400)*1000),today=new Date(now*1000);
  const startDay=start.toISOString().slice(0,10),todayDay=today.toISOString().slice(0,10),startMonth=startDay.slice(0,7),currentMonth=todayDay.slice(0,7),stamp=now;
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare('DELETE FROM usage_rollups_daily WHERE day>=? AND day<=?').run(startDay,todayDay);
    db.prepare(`INSERT INTO usage_rollups_daily(organization_id,day,event_type,feature,quantity,cost_minor,price_minor,currency,updated_at)
      SELECT organization_id,date(created_at,'unixepoch'),event_type,feature,SUM(quantity),SUM(cost_minor),SUM(price_minor),currency,?
      FROM usage_events WHERE created_at>=? AND created_at<? GROUP BY organization_id,date(created_at,'unixepoch'),event_type,feature,currency`).run(stamp,Math.floor(Date.parse(`${startDay}T00:00:00Z`)/1000),Math.floor(Date.parse(`${new Date((now+86400)*1000).toISOString().slice(0,10)}T00:00:00Z`)/1000));
    db.prepare('DELETE FROM usage_rollups_monthly WHERE month>=? AND month<=?').run(startMonth,currentMonth);
    db.prepare(`INSERT INTO usage_rollups_monthly(organization_id,month,event_type,feature,quantity,cost_minor,price_minor,currency,updated_at)
      SELECT organization_id,substr(date(created_at,'unixepoch'),1,7),event_type,feature,SUM(quantity),SUM(cost_minor),SUM(price_minor),currency,?
      FROM usage_events WHERE created_at>=? AND created_at<? GROUP BY organization_id,substr(date(created_at,'unixepoch'),1,7),event_type,feature,currency`).run(stamp,Math.floor(Date.parse(`${startMonth}-01T00:00:00Z`)/1000),Math.floor(Date.parse(`${new Date((now+86400)*1000).toISOString().slice(0,10)}T00:00:00Z`)/1000));
    const day=todayDay;
    db.prepare(`INSERT INTO organization_resource_snapshots(organization_id,day,workers,sites,active_users,created_at)
      SELECT o.id,?,(SELECT COUNT(*) FROM workers w WHERE w.organization_id=o.id),(SELECT COUNT(*) FROM sites s WHERE s.organization_id=o.id),(SELECT COUNT(*) FROM users u WHERE u.organization_id=o.id AND u.email_verified_at IS NOT NULL),?
      FROM organizations o WHERE 1=1 ON CONFLICT(organization_id,day) DO UPDATE SET workers=excluded.workers,sites=excluded.sites,active_users=excluded.active_users,created_at=excluded.created_at`).run(day,stamp);
    db.exec('COMMIT');
    return {startDay,todayDay,startMonth,currentMonth};
  }catch(error){db.exec('ROLLBACK');throw error;}
}
