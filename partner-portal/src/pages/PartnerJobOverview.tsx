import {
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  Grid,
  Paper,
  Typography,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { getPortalRoute } from '../navigation/catalog';

interface PartnerJobDefinition {
  id: string;
  title: string;
  description: string;
  primaryRouteId: string;
  secondaryRouteId: string;
}

export interface PartnerJobOverviewItem extends PartnerJobDefinition {
  status: 'Ready to start';
  primaryAction: string;
  primaryDestination: string;
  secondaryAction: string;
  secondaryDestination: string;
}

const partnerJobDefinitions: readonly PartnerJobDefinition[] = [
  {
    id: 'create-task',
    title: 'Run a task',
    description: 'Create a focused automation task, then follow its progress and results.',
    primaryRouteId: 'task-create',
    secondaryRouteId: 'tasks',
  },
  {
    id: 'create-workflow',
    title: 'Build a workflow',
    description: 'Combine tasks into a repeatable workflow and run it when your process is ready.',
    primaryRouteId: 'workflow-new',
    secondaryRouteId: 'workflows',
  },
];

export function getPartnerJobOverview(): readonly PartnerJobOverviewItem[] {
  return partnerJobDefinitions.map((job) => {
    const primaryRoute = getPortalRoute(job.primaryRouteId);
    const secondaryRoute = getPortalRoute(job.secondaryRouteId);

    return {
      ...job,
      status: 'Ready to start',
      primaryAction: primaryRoute.label,
      primaryDestination: primaryRoute.destination,
      secondaryAction: secondaryRoute.label,
      secondaryDestination: secondaryRoute.destination,
    };
  });
}

export default function PartnerJobOverview() {
  const jobs = getPartnerJobOverview();

  return (
    <Box sx={{ maxWidth: 960, mx: 'auto', py: { xs: 2, sm: 4 } }}>
      <Paper elevation={0} sx={{ p: { xs: 3, sm: 4 }, mb: 3, bgcolor: 'primary.main', color: 'primary.contrastText' }}>
        <Typography component="h1" variant="h4" gutterBottom>
          Start your partner work
        </Typography>
        <Typography>
          Choose the job you want to complete. Each option shows the next step and where to return for progress.
        </Typography>
      </Paper>

      <Grid container spacing={3}>
        {jobs.map((job) => (
          <Grid item xs={12} md={6} key={job.id}>
            <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
              <CardContent sx={{ flexGrow: 1 }}>
                <Chip label={job.status} color="success" size="small" sx={{ mb: 2 }} />
                <Typography component="h2" variant="h5" gutterBottom>
                  {job.title}
                </Typography>
                <Typography color="text.secondary">{job.description}</Typography>
              </CardContent>
              <CardActions sx={{ px: 2, pb: 2, gap: 1, flexWrap: 'wrap' }}>
                <Button component={RouterLink} to={job.primaryDestination} variant="contained">
                  {job.primaryAction}
                </Button>
                <Button component={RouterLink} to={job.secondaryDestination} variant="text">
                  View {job.secondaryAction}
                </Button>
              </CardActions>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}
