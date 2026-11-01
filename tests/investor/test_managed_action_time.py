"""Fictional re-sealed metadata attacks; never changes a production database."""

import json
import unittest

from tests.investor import test_managed_actions as fixture
from worker.investor import managed_actions as managed
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash


class ManagedActionTimeTests(unittest.TestCase):
    setUp = fixture.ManagedActionTests.setUp
    prepare = fixture.ManagedActionTests.prepare
    policy = fixture.ManagedActionTests.policy
    grant = fixture.ManagedActionTests.grant
    next_source_day = fixture.ManagedActionTests.next_source_day

    def unguard(self, *tables):
        for table in (*tables, 'audit_events'):
            for row in self.db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?", (table,)).fetchall():
                self.db.execute('DROP TRIGGER ' + row[0])

    def reseal(self, table, identifier, *, created=None, columns=None, **changes):
        row=self.db.execute('SELECT * FROM '+table+' WHERE id=?',(identifier,)).fetchone()
        doc=json.loads(row['document_json']);doc.update(changes)
        if created is not None and 'created_at' in doc:doc['created_at']=created
        values={'document_json':canonical_json(doc),'content_hash':content_hash(doc),'created_at':created or row['created_at'],**(columns or {})}
        self.db.execute('UPDATE '+table+' SET '+','.join(key+'=?' for key in values)+' WHERE id=?',(*values.values(),identifier))
        self.db.execute('UPDATE audit_events SET payload_json=?,created_at=? WHERE id=?',
            (canonical_json({'content_hash':content_hash(doc)}),created or row['created_at'],row['audit_id']))
        return content_hash(doc)

    def test_rule_cannot_predate_its_frozen_anchor(self):
        self.prepare();self.grant();first=managed.publish_current_actions(self.db,now=fixture.AT)[0]
        self.unguard('investor_action_authorities')
        self.reseal('investor_action_authorities',self.authority['id'],created='2026-11-01T05:00:02.000Z')
        with self.assertRaises(WorkbenchError):managed.resolve_managed_review(self.db,'w',first['publication_id'],now=fixture.LATER)

    def test_publication_cannot_include_evidence_from_its_future(self):
        self.prepare();self.grant();managed.publish_current_actions(self.db,now=fixture.AT)
        self.next_source_day();second=managed.publish_current_actions(self.db,now=fixture.LATER)[0]
        row=self.db.execute('SELECT * FROM investor_action_publications WHERE id=?',(second['publication_id'],)).fetchone()
        self.unguard('investor_action_requests','investor_action_publications','investor_data_sources')
        early='2026-11-02T06:00:02.000Z'
        digest=self.reseal('investor_action_requests',row['request_id'],created=early)
        self.reseal('investor_action_publications',row['id'],created=early,request_hash=digest)
        self.reseal('investor_data_sources',row['source_id'],created=early)
        with self.assertRaises(WorkbenchError):managed.resolve_managed_review(self.db,'w',row['id'],now=fixture.LATER)

    def test_publication_cannot_cross_the_intent_deadline(self):
        self.prepare();self.grant();first=managed.publish_current_actions(self.db,now=fixture.AT)[0]
        row=self.db.execute('SELECT * FROM investor_action_publications WHERE id=?',(first['publication_id'],)).fetchone()
        self.unguard('investor_action_publications','investor_data_sources')
        late='2026-11-02T05:00:00.000Z'
        self.reseal('investor_action_publications',row['id'],created=late)
        self.reseal('investor_data_sources',row['source_id'],created=late)
        with self.assertRaises(WorkbenchError):managed.resolve_managed_review(self.db,'w',row['id'],now=fixture.LATER)

    def test_published_header_must_advance_beyond_prior_published_coverage(self):
        self.prepare();self.grant();managed.publish_current_actions(self.db,now=fixture.AT)
        self.next_source_day();second=managed.publish_current_actions(self.db,now=fixture.LATER)[0]
        value=managed.managed_review_header(self.db,'w',second['publication_id'],fixture.LATER)
        doc=json.loads(value['review']['document_json']);doc['facts']['range_end']='2026-10-31'
        digest=content_hash(doc)
        self.unguard('investor_action_publications')
        self.reseal('investor_action_publications',second['publication_id'],columns={'coverage_end':'2026-10-31','review_hash':digest},
            coverage_end='2026-10-31',review_hash=digest,candidate_facts_hash=content_hash(doc['facts']))
        with self.assertRaises(WorkbenchError):managed.managed_review_header(self.db,'w',second['publication_id'],fixture.LATER)


if __name__ == '__main__':unittest.main()
