"""Explicit synthetic old stores for migration acceptance; never use on user data."""
def downgrade_to_19(db):
    version=db.execute('PRAGMA user_version').fetchone()[0]
    if version!=25:
        raise AssertionError('Synthetic schema fixture must be reviewed when latest schema changes')
    db.execute('DROP TABLE trial_events')
    db.execute('DROP TABLE trial_sessions')
    db.execute('DELETE FROM schema_migrations WHERE version=25')
    db.execute('DROP TABLE document_proposals')
    db.execute('DELETE FROM schema_migrations WHERE version=24')
    for table in ('publication_records','bookmark_seeds','bookmarks','document_deliveries','document_import_originals',
                  'document_versions','document_working','documents'):
        db.execute(f'DROP TABLE {table}')
    db.execute('DELETE FROM schema_migrations WHERE version=23')
    db.execute('DROP TABLE writing_skill_settings')
    db.execute('DELETE FROM schema_migrations WHERE version=22')
    db.execute('DROP TABLE creative_send_receipts')
    db.execute('DELETE FROM schema_migrations WHERE version=21')
    db.execute('DROP TABLE proposal_decision_drafts')
    db.execute('DELETE FROM schema_migrations WHERE version=20')
    db.execute('PRAGMA user_version=19')
