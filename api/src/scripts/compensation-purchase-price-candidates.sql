-- Read-only audit; DB search_path must be the collector's raw schema.
-- Date parameters: %(from)s, %(to)s (exclusive), %(floor)s, %(verified_to)s; optional %(activity)s GUID.
with cfg as (select %(from)s::date as from_day,%(to)s::date as to_day,%(activity)s::text as activity),
acts as materialized (
 select a.ref_key as activity_key, a.naimenovanie_aktsii as activity_name, a.dlya_vseh_magazinov,
 greatest(cfg.from_day,nullif(a.data_nachala_deystviya::date,'0001-01-01')) as from_day,
 least(cfg.to_day,nullif(a.data_okonchaniya_deystviya::date,'0001-01-01')+1) as to_day
 from cfg cross join document_marketingovaya_aktsiya a
 where a.posted is true and a.deletion_mark is not true and (cfg.activity is null or a.ref_key=cfg.activity)
 and (a.data_nachala_deystviya is null or a.data_nachala_deystviya < cfg.to_day)
 and (a.data_okonchaniya_deystviya is null or a.data_okonchaniya_deystviya::date<='0001-01-01' or a.data_okonchaniya_deystviya::date>=cfg.from_day)
),
scopes as materialized (
 select distinct a.activity_key, bs.store_key, m.nomenklatura_key item_key,
 nullif(nullif(m.harakteristika_key,''),'00000000-0000-0000-0000-000000000000') characteristic_key,
 greatest(a.from_day,nullif(r.data_nachala::date,'0001-01-01')) from_day,
 least(a.to_day,nullif(r.data_okonchaniya::date,'0001-01-01')+1) to_day
 from acts a
 join document_marketingovaya_aktsiya_skidki_natsenki r on coalesce(nullif(nullif(r._parent_ref_key,''),'00000000-0000-0000-0000-000000000000'),r.ref_key)=a.activity_key
 join catalog_skidki_natsenki d on d.ref_key=r.skidka_natsenka_key and d.deletion_mark is not true
 join catalog_segmenty_nomenklatury g on g.ref_key=d.segment_nomenklatury_predostavleniya_key and g.deletion_mark is not true
 join information_register_nomenklatura_segmenta m on m.segment_key=g.ref_key and coalesce(m.nomenklatura_key,'') not in ('','00000000-0000-0000-0000-000000000000')
 left join lateral (
   select r.magazin_key store_key where coalesce(r.magazin_key,'') not in ('','00000000-0000-0000-0000-000000000000')
   union all
   select s.ref_key from catalog_magaziny s where coalesce(r.magazin_key,'') in ('','00000000-0000-0000-0000-000000000000') and a.dlya_vseh_magazinov is true and s.deletion_mark is not true
   union all
   select s.magazin_key from document_marketingovaya_aktsiya_magaziny s where coalesce(r.magazin_key,'') in ('','00000000-0000-0000-0000-000000000000') and a.dlya_vseh_magazinov is not true and coalesce(nullif(nullif(s._parent_ref_key,''),'00000000-0000-0000-0000-000000000000'),s.ref_key)=a.activity_key
 ) bs on coalesce(bs.store_key,'') not in ('','00000000-0000-0000-0000-000000000000')
),
scope_windows as materialized (
 select activity_key,store_key,item_key,characteristic_key,from_day,to_day
 from scopes where store_key is not null
 union all
 -- An unassigned movement is a diagnostic, never attributed to any candidate store.
 select distinct activity_key,null::text,item_key,characteristic_key,from_day,to_day from scopes
),
reports as materialized (
 select r.ref_key,s.ref_key store_key,r.date movement_at
 from cfg cross join document_otchet_o_roznichnyh_prodazhah r
 left join catalog_magaziny s on s.ref_key=r.magazin_key and s.deletion_mark is not true and s.is_folder is not true
 where r.date>=cfg.from_day and r.date<cfg.to_day and r.posted is true and r.deletion_mark is not true
),
movements as materialized (
 select s._id as line_key,r.*,s.nomenklatura_key item_key,coalesce(nullif(s.harakteristika_key,'00000000-0000-0000-0000-000000000000'),'') characteristic,s.kolichestvo quantity,s.tsena::numeric retail_price,'sale'::text kind
 from reports r join document_otchet_o_roznichnyh_prodazhah_tovary s on coalesce(s._parent_ref_key,s.ref_key)=r.ref_key
 where (s.kolichestvo<>0 or s.kolichestvo is null) and s.nomenklatura_key in (select distinct item_key from scopes)
 union all
 select s._id,r.*,s.nomenklatura_key,coalesce(nullif(s.harakteristika_key,'00000000-0000-0000-0000-000000000000'),''),-abs(s.kolichestvo),(to_jsonb(s)->>'tsena')::numeric,'return'
 from reports r join document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary s on coalesce(s._parent_ref_key,s.ref_key)=r.ref_key
 where (s.kolichestvo<>0 or s.kolichestvo is null) and s.nomenklatura_key in (select distinct item_key from scopes)
),
matched as materialized (
 select m.store_key,m.item_key,m.characteristic,m.movement_at,
 count(distinct (m.kind,m.line_key)) movement_lines,
 count(distinct m.line_key) filter(where m.kind='sale') sale_lines,
 count(distinct m.line_key) filter(where m.kind='return') return_lines,
 count(distinct m.line_key) filter(where m.kind='return' and m.retail_price is null) missing_retail_return_lines,
 array_agg(distinct s.activity_key order by s.activity_key) activities
 from movements m join scope_windows s on coalesce(s.store_key,'')=coalesce(m.store_key,'') and s.item_key=m.item_key and coalesce(s.characteristic_key,'')=m.characteristic
  and m.movement_at>=s.from_day and m.movement_at<s.to_day
 group by 1,2,3,4
),
keys as materialized (
 select m.*,p.ref_key price_type_key
 from matched m
 left join catalog_magaziny s on s.ref_key=m.store_key and s.deletion_mark is not true and s.is_folder is not true
 left join catalog_vidy_tsen p on p.ref_key=s.vid_tsen_zakupa_key and p.deletion_mark is not true and p.is_folder is not true
),
needed as materialized (
 select price_type_key,item_key,characteristic,max(movement_at) last_movement
 from keys where price_type_key is not null group by 1,2,3
),
changes as materialized (
 select n.price_type_key,n.item_key,n.characteristic,d.date as effective_at,count(distinct l.tsena) as distinct_prices,
 bool_or(l.tsena is null or l.tsena::text in ('NaN','Infinity','-Infinity') or l.tsena<=0) as invalid_price,
 min(l.tsena) price, array_agg(distinct d.ref_key order by d.ref_key) as document_keys,
 lead(d.date) over(partition by n.price_type_key,n.item_key,n.characteristic order by d.date) as next_at
 from needed n
 join document_ustanovka_tsen_nomenklatury_tovary l on l.vid_tseny_key=n.price_type_key and l.nomenklatura_key=n.item_key
  and coalesce(nullif(l.harakteristika_key,'00000000-0000-0000-0000-000000000000'),'')=n.characteristic
  and coalesce(l.upakovka_key,'') in ('','00000000-0000-0000-0000-000000000000')
 join document_ustanovka_tsen_nomenklatury d on d.ref_key=coalesce(l._parent_ref_key,l.ref_key)
  and d.posted is true and d.deletion_mark is not true and d.date<=n.last_movement
 group by n.price_type_key,n.item_key,n.characteristic,d.date
),
results as (
 select k.*,c.effective_at,c.next_at,c.price,c.document_keys,
 case when k.store_key is null then 'missing_branch'
 when k.price_type_key is null then 'missing_purchase_price_type'
 when c.effective_at is null and (%(floor)s::date is null or k.movement_at<%(floor)s::date or k.movement_at>=%(verified_to)s::date) then 'purchase_price_unverified'
 when c.effective_at is null then 'missing_purchase_price'
 when c.distinct_prices>1 then 'ambiguous_purchase_price'
 when c.invalid_price then 'missing_purchase_price'
 when %(floor)s::date is null or c.effective_at<%(floor)s::date or k.movement_at>=%(verified_to)s::date then 'purchase_price_unverified'
 else 'local_candidate' end as local_status
 from keys k left join changes c on c.price_type_key=k.price_type_key and c.item_key=k.item_key and c.characteristic=k.characteristic
 and k.movement_at>=c.effective_at and (c.next_at is null or k.movement_at<c.next_at)
)
select z.*,nullif(z.characteristic,'') characteristic_key,p.description price_type_name,s.description store_name,i.description item_name
from results z
left join catalog_vidy_tsen p on p.ref_key=z.price_type_key left join catalog_magaziny s on s.ref_key=z.store_key left join catalog_nomenklatura i on i.ref_key=z.item_key
order by z.price_type_key,z.item_key,z.characteristic,z.movement_at,z.store_key
