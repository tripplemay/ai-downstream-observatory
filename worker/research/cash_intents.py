"""Research-only sale-to-buy lineage; never rewrites a published order."""

from copy import deepcopy

from worker.orchestration.db import WorkbenchError, content_hash, instant, stamp


class CashIntents:
    def __init__(self, orders, events, reviews, policy_hash):
        self.orders, self.events, self.reviews, self.policy_hash = orders, events, reviews, policy_hash
        self.rows, self.active_id = {}, None

    @property
    def active(self):
        return self.rows.get(self.active_id)

    def declare(self, sales, buy_scope, at, deadline):
        if self.active is not None or not sales or not buy_scope or at >= deadline:
            raise WorkbenchError('CASH_INTENT_DECLARATION_INVALID')
        identity = 'cash-intent:%06d' % (len(self.rows) + 1)
        declaration = {'id': identity, 'declared_at': stamp(at), 'deadline': stamp(deadline),
                       'policy_hash': self.policy_hash, 'sale_order_ids': list(sales),
                       'buy_listing_ids': sorted(buy_scope)}
        row = {'declaration': declaration, 'declaration_hash': content_hash(declaration),
               'state': 'waiting_sales', 'current_sale_order_ids': list(sales),
               'buy_order_ids': [], 'current_buy_order_ids': [], 'prepared_hash': None,
               'completed_at': None, 'reason': None}
        self.rows[identity], self.active_id = row, identity
        for key in sales:
            self.orders[key]['cash_intent_id'] = identity
        self.events.append({'type': 'cash_intent_declared', 'at': stamp(at),
                            'declaration': deepcopy(declaration), 'declaration_hash': row['declaration_hash']})

    def bind_replacements(self, planned, at):
        row = self.active
        if row is None:
            return
        side = 'sell' if row['state'] in ('waiting_sales', 'waiting_decision') else 'buy'
        if row['state'] not in ('waiting_sales', 'waiting_decision', 'buy_published') or any(
                order['side'] != side or not order.get('origin_review_id') for order in planned):
            raise WorkbenchError('CASH_INTENT_REPLACEMENT_SCOPE_INVALID')
        identity = row['declaration']['id']
        for order in planned:
            if order['expires_at'] > instant(row['declaration']['deadline']):
                raise WorkbenchError('CASH_INTENT_DEADLINE_EXTENDED')
            order['cash_intent_id'] = identity
        self.events.append({'type': 'cash_intent_replacements_bound', 'at': stamp(at), 'intent_id': identity,
                            'side': side, 'order_ids': [order['id'] for order in planned]})

    def _leaves(self, row, roots, side):
        identity, seen = row['declaration']['id'], set()

        def follow(key, path):
            if key in path:
                raise WorkbenchError('CASH_INTENT_LINEAGE_CYCLE')
            order = self.orders[key]
            if order.get('cash_intent_id') != identity or order['side'] != side:
                raise WorkbenchError('CASH_INTENT_LINEAGE_SCOPE_INVALID')
            if order['state'] not in ('skipped', 'expired'):
                seen.add(key)
                return True
            cancellation = next((event for event in self.events if event['type'] == 'execution_skipped'
                                 and event.get('order_id') == key and 'cancellation_review_id' in event), None)
            if cancellation is None:
                return False
            review = self.reviews.rows[cancellation['cancellation_review_id']]
            if review['status'] == 'failed':
                return False
            replacement = next((event for event in self.events if event['type'] == 'order_review_reproposal'
                                and event['review_id'] == review['id'] and key in event['replaces_order_ids']), None)
            if replacement is not None:
                children = replacement['order_ids']
                if not children or any(self.orders[child]['side'] != side for child in children):
                    raise WorkbenchError('CASH_INTENT_REPLACEMENT_SCOPE_INVALID')
                return all([follow(child, path | {key}) for child in children])
            if review['status'] == 'resolved' and review['completion_reason'] in (
                    'targets_within_tolerance', 'no_sales_repair_no_longer_needed', 'sale_scope_no_longer_needed'):
                return True
            seen.add(key)
            return True

        valid = all([follow(key, set()) for key in roots])
        return valid, sorted(seen)

    def refresh(self, at):
        row = self.active
        if row is None or row['state'] in ('failed', 'expired'):
            return
        if content_hash(row['declaration']) != row['declaration_hash']:
            raise WorkbenchError('CASH_INTENT_DECLARATION_CHANGED')
        if at >= instant(row['declaration']['deadline']):
            row.update(state='expired', reason='CASH_INTENT_DEADLINE_REACHED')
            self.events.append({'type': 'cash_intent_failed', 'at': stamp(at),
                                'intent_id': row['declaration']['id'], 'reason': row['reason']})
            return
        buying = row['state'] == 'buy_published'
        valid, leaves = self._leaves(row, row['buy_order_ids'] if buying else row['declaration']['sale_order_ids'],
                                     'buy' if buying else 'sell')
        row['current_buy_order_ids' if buying else 'current_sale_order_ids'] = leaves
        if not valid:
            row.update(state='failed', reason='CASH_INTENT_PUBLISHED_ORDER_FAILED')
            self.events.append({'type': 'cash_intent_failed', 'at': stamp(at),
                                'intent_id': row['declaration']['id'], 'reason': row['reason']})
        elif buying and all(self.orders[key]['state'] in ('filled', 'settled') for key in leaves):
            self.resolve(at, 'buy_orders_completed' if leaves else 'reviewed_buy_scope_no_longer_needed')
        elif not buying:
            row['state'] = 'waiting_decision' if all(self.orders[key]['state'] == 'settled' for key in leaves) else 'waiting_sales'

    def publish(self, planned, preparation, at):
        row = self.active
        if row is None or row['state'] != 'waiting_decision' or not planned or row['buy_order_ids'] or any(
                order['side'] != 'buy' for order in planned):
            raise WorkbenchError('CASH_INTENT_BUY_ALREADY_PUBLISHED_OR_UNREADY')
        identity = row['declaration']['id']
        if (preparation['intent_id'] != identity or preparation['policy_hash'] != self.policy_hash
                or preparation['decision_at'] != stamp(at) or preparation['published'] is not False
                or preparation['live_advice_eligible'] is not False
                or [order['id'] for order in planned] != [order['order_id'] for order in preparation['orders']]):
            raise WorkbenchError('CASH_INTENT_PREPARATION_BINDING_INVALID')
        for order in planned:
            order['cash_intent_id'] = identity
        row.update(state='buy_published', buy_order_ids=[order['id'] for order in planned], prepared_hash=content_hash(preparation))
        self.events.append({'type': 'cash_intent_buy_published', 'at': stamp(at), 'intent_id': identity,
                            'preparation': deepcopy(preparation), 'preparation_hash': row['prepared_hash']})

    def resolve(self, at, reason):
        row = self.active
        if row is None or row['state'] in ('failed', 'expired'):
            raise WorkbenchError('CASH_INTENT_COMPLETION_INVALID')
        row.update(state='resolved', completed_at=stamp(at), reason=reason)
        self.events.append({'type': 'cash_intent_resolved', 'at': stamp(at), 'intent_id': row['declaration']['id'], 'reason': reason})
        self.active_id = None

    def result(self):
        events = [event for event in self.events if event['type'].startswith('cash_intent_')]
        return {'cash_intents': deepcopy(list(self.rows.values())),
                'pending_cash_intent_count': sum(row['state'] in ('waiting_sales', 'waiting_decision', 'buy_published') for row in self.rows.values()),
                'failed_cash_intent_count': sum(row['state'] in ('failed', 'expired') for row in self.rows.values()),
                'cash_intent_lineage_hash': content_hash({'events': events, 'intents': list(self.rows.values())})}
