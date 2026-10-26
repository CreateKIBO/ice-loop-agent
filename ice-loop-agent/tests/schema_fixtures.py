"""Explicit synthetic old stores for migration acceptance; never use on user data."""
def downgrade_to_19(db):
    version=db.execute('PRAGMA user_version').fetchone()[0]
    if version!=21:
        raise AssertionError('Synthetic schema fixture must be reviewed when latest schema changes')
    db.execute('DROP TABLE creative_send_receipts')
    db.execute('DELETE FROM schema_migrations WHERE version=21')
    db.execute('DROP TABLE proposal_decision_drafts')
    db.execute('DELETE FROM schema_migrations WHERE version=20')
    db.execute('PRAGMA user_version=19')
