import unittest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone, timedelta
import json
from botocore.exceptions import ClientError

# Import the functions we want to test
from task_monitor import (
    get_pending_executions,
    get_due_schedules,
    create_execution,
    update_schedule_next_run_time,
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

        # Verify result and last_execution_time update
        self.assertEqual(result, mock_items)
        self.assertEqual(task_monitor.last_execution_time, '2024-01-22T00:00:00Z')

    @patch('task_monitor.schedules_table')
    def test_get_due_schedules(self, mock_table):
        # Setup mock response
        mock_items = [
            {
                'scheduleId': '1',
                'taskId': 'task1',
                'status': 'active',
                'nextRunTime': '2024-01-22T00:00:00Z'
            }
        ]
        mock_table.query.return_value = {'Items': mock_items}

        # Call function
        result = get_due_schedules()

        # Verify query parameters
        mock_table.query.assert_called_once()
        call_args = mock_table.query.call_args[1]
        self.assertEqual(call_args['IndexName'], 'StatusStartTimeIndex')
        self.assertEqual(
            call_args['KeyConditionExpression'],
            '#status = :status AND #nextRunTime <= :now'
        )

        # Verify result
        self.assertEqual(result, mock_items)

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

    @patch('task_monitor.schedules_table')
    def test_update_schedule_next_run_time(self, mock_table):
        # Test daily schedule
        daily_schedule = {
            'scheduleId': '1',
            'frequency': 'daily'
        }
        update_schedule_next_run_time(daily_schedule)
        mock_table.update_item.assert_called_once()

        # Reset mock and test weekly schedule
        mock_table.reset_mock()
        weekly_schedule = {
            'scheduleId': '2',
            'frequency': 'weekly'
        }
        update_schedule_next_run_time(weekly_schedule)
        mock_table.update_item.assert_called_once()

        # Reset mock and test monthly schedule
        mock_table.reset_mock()
        monthly_schedule = {
            'scheduleId': '3',
            'frequency': 'monthly'
        }
        update_schedule_next_run_time(monthly_schedule)
        mock_table.update_item.assert_called_once()

    @patch('task_monitor.executions_table')
    def test_update_execution_status(self, mock_table):
        execution_id = '1'
        status = 'completed'
        result = 'Task completed successfully'

        # Call function
        update_execution_status(execution_id, status, result=result)

        # Verify update_item was called with correct parameters
        mock_table.update_item.assert_called_once()
        update_args = mock_table.update_item.call_args[1]
        self.assertEqual(update_args['Key']['executionId'], execution_id)
        self.assertIn('SET #status = :status', update_args['UpdateExpression'])
        self.assertEqual(update_args['ExpressionAttributeValues'][':status'], status)
        self.assertEqual(update_args['ExpressionAttributeValues'][':result'], result)

    @patch('task_monitor.executions_table')
    def test_update_execution_status_with_error(self, mock_table):
        execution_id = '1'
        status = 'failed'
        error = 'Task execution failed'

        # Call function
        update_execution_status(execution_id, status, error=error)

        # Verify update_item was called with correct parameters
        mock_table.update_item.assert_called_once()
        update_args = mock_table.update_item.call_args[1]
        self.assertEqual(update_args['Key']['executionId'], execution_id)
        self.assertIn('SET #status = :status', update_args['UpdateExpression'])
        self.assertEqual(update_args['ExpressionAttributeValues'][':status'], status)
        self.assertEqual(update_args['ExpressionAttributeValues'][':error'], error)

if __name__ == '__main__':
    unittest.main() 