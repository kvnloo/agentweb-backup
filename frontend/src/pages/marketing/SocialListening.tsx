import React, { useState } from 'react';
import { 
  Box, 
  Typography, 
  Button, 
  Container, 
  Paper, 
  Tabs, 
  Tab,
  Grid,
  Card,
  CardContent,
  List,
  ListItem,
  ListItemText,
  ListItemAvatar,
  Avatar,
  useTheme
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import FacebookIcon from '@mui/icons-material/Facebook';
import TwitterIcon from '@mui/icons-material/Twitter';
import InstagramIcon from '@mui/icons-material/Instagram';

// Placeholder components to be implemented later
const SocialMetrics = () => (
  <Grid container spacing={3}>
    {['Facebook', 'Twitter', 'LinkedIn', 'Instagram'].map((platform) => (
      <Grid item xs={12} sm={6} md={3} key={platform}>
        <Card>
          <CardContent>
            <Typography variant="h6" gutterBottom>{platform}</Typography>
            <Typography variant="h4">1,243</Typography>
            <Typography variant="body2" color="text.secondary">Mentions this week</Typography>
          </CardContent>
        </Card>
      </Grid>
    ))}
  </Grid>
);

const SentimentChart = () => (
  <Paper sx={{ p: 3 }}>
    <Typography variant="h6" gutterBottom>Sentiment Analysis</Typography>
    <Box sx={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Typography variant="body1" color="text.secondary">Chart visualization will be implemented here</Typography>
    </Box>
  </Paper>
);

const RecentMentions = () => {
  const theme = useTheme();
  
  return (
    <Paper sx={{ p: 3 }}>
      <Typography variant="h6" gutterBottom>Recent Mentions</Typography>
      <List>
        {[1, 2, 3].map((item) => (
          <ListItem key={item} sx={{ 
            mb: 1, 
            borderBottom: `1px solid ${theme.palette.divider}`,
            pb: 1
          }}>
            <ListItemAvatar>
              <Avatar>
                <TwitterIcon />
              </Avatar>
            </ListItemAvatar>
            <ListItemText
              primary="@username"
              secondary="Your product has been amazing for our team's productivity. #recommended"
            />
          </ListItem>
        ))}
      </List>
    </Paper>
  );
};

const ConnectedNetworks = () => {
  const networks = [
    { name: 'Facebook', icon: <FacebookIcon />, connected: true },
    { name: 'Twitter', icon: <TwitterIcon />, connected: true },
    { name: 'Instagram', icon: <InstagramIcon />, connected: false }
  ];
  
  return (
    <Paper sx={{ p: 3 }}>
      <Typography variant="h6" gutterBottom>Connected Networks</Typography>
      <List>
        {networks.map((network) => (
          <ListItem key={network.name} sx={{ py: 2 }}>
            <ListItemAvatar>
              <Avatar sx={{ bgcolor: network.connected ? 'primary.main' : 'grey.300' }}>
                {network.icon}
              </Avatar>
            </ListItemAvatar>
            <ListItemText
              primary={network.name}
              secondary={network.connected ? 'Connected' : 'Not connected'}
            />
            <Button 
              variant={network.connected ? "outlined" : "contained"} 
              color={network.connected ? "error" : "primary"}
            >
              {network.connected ? 'Disconnect' : 'Connect'}
            </Button>
          </ListItem>
        ))}
      </List>
    </Paper>
  );
};

const SocialListening: React.FC = () => {
  const [tabValue, setTabValue] = useState(0);

  const handleTabChange = (_: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
  };

  return (
    <Box sx={{ bgcolor: 'grey.50', minHeight: '100vh', py: 4 }}>
      <Container maxWidth="lg">
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 4 }}>
          <Typography variant="h4" component="h1" fontWeight="bold">
            Social Listening
          </Typography>
          <Button variant="outlined" startIcon={<RefreshIcon />}>
            Refresh
          </Button>
        </Box>

        <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 4 }}>
          <Tabs 
            value={tabValue} 
            onChange={handleTabChange}
            indicatorColor="primary"
            textColor="primary"
          >
            <Tab label="Overview" />
            <Tab label="Connected Accounts" />
            <Tab label="Settings" />
          </Tabs>
        </Box>

        <Box sx={{ mb: 4 }}>
          {tabValue === 0 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <SocialMetrics />
              <SentimentChart />
              <RecentMentions />
            </Box>
          )}
          
          {tabValue === 1 && (
            <ConnectedNetworks />
          )}
          
          {tabValue === 2 && (
            <Paper sx={{ p: 3 }}>
              <Typography variant="h6" gutterBottom>Social Listening Settings</Typography>
              <Typography variant="body1" color="text.secondary">
                Configure your social listening preferences here.
              </Typography>
            </Paper>
          )}
        </Box>
      </Container>
    </Box>
  );
};

export default SocialListening; 