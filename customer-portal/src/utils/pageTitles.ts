export const getPageTitle = (pathname: string): string => {
  switch (pathname) {
    case "/":
      return "Dashboard";
    case "/settings":
      return "Account Settings";
    case "/market-research-report":
      return "Market Research Reports";
    default:
      return "Customer Portal";
  }
};
