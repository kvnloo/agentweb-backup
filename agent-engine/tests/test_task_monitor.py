import asyncio
import unittest
from unittest.mock import patch, MagicMock, AsyncMock
from datetime import datetime, timezone, timedelta
import json
from botocore.exceptions import ClientError

# Import the functions we want to test
from task_monitor import (
    get_pending_executions,
    create_execution,
    update_execution_status
)

class TestTaskMonitor(unittest.TestCase):
    def setUp(self):
        # Reset last_execution_time before each test
        import task_monitor
        task_monitor.last_execution_time = None

    @patch('task_monitor.executions_table')
    def test_get_pending_executions_no_last_time(self, mock_table):
        # Setup mock response
        mock_items = [
            {
                'executionId': '1',
                'taskId': 'task1',
                'status': 'pending',
                'startTime': '2024-01-22T00:00:00Z'
            }
        ]
        mock_table.query.return_value = {'Items': mock_items}

        # Call function
        result = get_pending_executions()

        # Verify query parameters
        mock_table.query.assert_called_once_with(
            IndexName='StatusStartTimeIndex',
            KeyConditionExpression='#status = :status',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':status': 'pending'}
        )

        # Verify result
        self.assertEqual(result, mock_items)

    @patch('task_monitor.executions_table')
    def test_get_pending_executions_with_last_time(self, mock_table):
        # Set last execution time
        import task_monitor
        task_monitor.last_execution_time = '2024-01-21T00:00:00Z'

        # Setup mock response
        mock_items = [
            {
                'executionId': '2',
                'taskId': 'task2',
                'status': 'pending',
                'startTime': '2024-01-22T00:00:00Z'
            }
        ]
        mock_table.query.return_value = {'Items': mock_items}

        # Call function
        result = get_pending_executions()

        # Verify query parameters include startTime condition
        mock_table.query.assert_called_once_with(
            IndexName='StatusStartTimeIndex',
            KeyConditionExpression='#status = :status AND #startTime > :startTime',
            ExpressionAttributeNames={
                '#status': 'status',
                '#startTime': 'startTime'
            },
            ExpressionAttributeValues={
                ':status': 'pending',
                ':startTime': '2024-01-21T00:00:00Z'
            }
        )

        # Verify result. last_execution_time is advanced by the caller
        # (monitor_executions()'s dispatch loop), not by this function -
        # get_pending_executions() only reads it to build the query.
        self.assertEqual(result, mock_items)
        self.assertEqual(task_monitor.last_execution_time, '2024-01-21T00:00:00Z')

    @patch('task_monitor.executions_table')
    def test_create_execution(self, mock_table):
        task_id = 'task1'
        user_id = 'user1'

        # Call function
        execution_id = create_execution(task_id, user_id)

        # Verify put_item was called
        mock_table.put_item.assert_called_once()
        put_item_args = mock_table.put_item.call_args[1]
        execution = put_item_args['Item']

        # Verify execution properties
        self.assertEqual(execution['taskId'], task_id)
        self.assertEqual(execution['userId'], user_id)
        self.assertEqual(execution['status'], 'pending')
        self.assertIsNotNone(execution['executionId'])
        self.assertIsNotNone(execution['startTime'])

    @patch('task_monitor.tasks_table')
    @patch('task_monitor.executions_table')
    def test_update_execution_status(self, mock_table, mock_tasks_table):
        execution_id = '1'
        status = 'completed'
        result = 'Task completed successfully'

        # status='completed' also makes update_execution_status() look up
        # tasks_table for notification details - give it a real dict so a
        # MagicMock never flows into that (unmocked-by-default) real boto3
        # call. Without this, execution['taskId'] resolves to an
        # auto-generated MagicMock, which boto3 then tries to deepcopy and
        # recurses infinitely (a well-known MagicMock+deepcopy interaction).
        mock_table.get_item.return_value = {'Item': {
            'executionId': execution_id,
            'taskId': 'task1',
            'status': 'running',
            'startTime': '2024-01-22T00:00:00Z',
        }}
        # No 'Item' key -> task is None -> notification branch is skipped.
        mock_tasks_table.get_item.return_value = {}

        # Call function
        update_execution_status(execution_id, status, result=result)

        # Verify update_item was called with correct parameters
        mock_table.update_item.assert_called_once()
        update_args = mock_table.update_item.call_args[1]
        self.assertEqual(update_args['Key']['executionId'], execution_id)
        self.assertIn('SET #status = :status', update_args['UpdateExpression'])
        self.assertEqual(update_args['ExpressionAttributeValues'][':status'], status)
        self.assertEqual(update_args['ExpressionAttributeValues'][':result'], result)

    @patch('task_monitor.tasks_table')
    @patch('task_monitor.executions_table')
    def test_update_execution_status_with_error(self, mock_table, mock_tasks_table):
        execution_id = '1'
        status = 'failed'
        error = 'Task execution failed'

        mock_table.get_item.return_value = {'Item': {
            'executionId': execution_id,
            'taskId': 'task1',
            'status': 'running',
            'startTime': '2024-01-22T00:00:00Z',
        }}
        mock_tasks_table.get_item.return_value = {}

        # Call function
        update_execution_status(execution_id, status, error=error)

        # Verify update_item was called with correct parameters
        mock_table.update_item.assert_called_once()
        update_args = mock_table.update_item.call_args[1]
        self.assertEqual(update_args['Key']['executionId'], execution_id)
        self.assertIn('SET #status = :status', update_args['UpdateExpression'])
        self.assertEqual(update_args['ExpressionAttributeValues'][':status'], status)
        self.assertEqual(update_args['ExpressionAttributeValues'][':error'], error)

class TestMonitorExecutionsDispatch(unittest.TestCase):
    """ENG-798: monitor_executions()'s dispatch loop must skip an execution
    if its userId is already running, not just track it. Regression tests
    for the dispatch-loop bug found during ENG-389 live testing (the loop
    comment claimed no-duplicate-userId dispatch, but never gated on it)."""

    def setUp(self):
        import task_monitor as tm
        self.tm = tm
        tm.last_execution_time = None
        tm.running_task_count = 0
        tm.running_user_ids = set()
        tm.running_processes = {}

    def _run_one_iteration(self, pending_executions, max_concurrent=3):
        """Runs monitor_executions() for exactly one loop pass by making the
        trailing asyncio.sleep raise CancelledError, which is not caught by
        the loop's `except Exception` (CancelledError is a BaseException),
        so it propagates out and stops the while True loop cleanly."""
        import os
        with patch.dict(os.environ, {'MAX_CONCURRENT_TASKS': str(max_concurrent)}), \
             patch('task_monitor.process_schedules', new_callable=AsyncMock), \
             patch('task_monitor.process_workflow_executions', new_callable=AsyncMock), \
             patch('task_monitor.execute_task', new_callable=AsyncMock) as mock_execute_task, \
             patch('task_monitor.get_pending_executions', return_value=pending_executions), \
             patch('task_monitor.asyncio.sleep', new_callable=AsyncMock, side_effect=asyncio.CancelledError()):
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(self.tm.monitor_executions())
            return mock_execute_task

    def test_skips_second_pending_execution_for_same_user(self):
        pending = [
            {'executionId': '1', 'userId': 'userA', 'startTime': 't1'},
            {'executionId': '2', 'userId': 'userA', 'startTime': 't2'},
            {'executionId': '3', 'userId': 'userB', 'startTime': 't3'},
        ]
        mock_execute_task = self._run_one_iteration(pending, max_concurrent=3)

        dispatched_ids = [call.args[0]['executionId'] for call in mock_execute_task.call_args_list]
        # userA's second execution ('2') must be skipped - userA already has '1' running.
        self.assertEqual(dispatched_ids, ['1', '3'])

    def test_duplicate_user_does_not_starve_later_users(self):
        # Regression guard against the naive fix (breaking the loop instead
        # of continuing past a duplicate-user execution), which would have
        # incorrectly stopped userC from ever being dispatched this cycle.
        pending = [
            {'executionId': '1', 'userId': 'userA', 'startTime': 't1'},
            {'executionId': '2', 'userId': 'userA', 'startTime': 't2'},
            {'executionId': '3', 'userId': 'userC', 'startTime': 't3'},
        ]
        mock_execute_task = self._run_one_iteration(pending, max_concurrent=3)

        dispatched_ids = [call.args[0]['executionId'] for call in mock_execute_task.call_args_list]
        self.assertIn('3', dispatched_ids)

    def test_respects_max_concurrent_with_no_duplicate_users(self):
        pending = [
            {'executionId': '1', 'userId': 'userA', 'startTime': 't1'},
            {'executionId': '2', 'userId': 'userB', 'startTime': 't2'},
            {'executionId': '3', 'userId': 'userC', 'startTime': 't3'},
        ]
        mock_execute_task = self._run_one_iteration(pending, max_concurrent=2)

        dispatched_ids = [call.args[0]['executionId'] for call in mock_execute_task.call_args_list]
        self.assertEqual(dispatched_ids, ['1', '2'])


if __name__ == '__main__':
    unittest.main()